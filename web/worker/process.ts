// One neutralise job: fetch the inputs, run the engine, store its drafts. Exit code 1 =
// failure, nothing is stored (ENGINE.md: a failed run has nothing usable).
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "../lib/db";
import type { DocType, Entity, Job } from "../lib/db/schema";
import { engineEntityJson, getEntity } from "../lib/entities";
import { MAX_FILE_BYTES, newUploadKey } from "../lib/files";
import { failJob, saveDrafts, type Draft } from "../lib/jobs/worker-state";
import type { Storage } from "../lib/storage";
import { cleanLog, engineArgv, runPython } from "./engine";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = "application/pdf";
const NAME_RE = /^(TMC|TMCGULF|PHARMALABO)_(COA|MSDS|TDS)_/;

/** A safe local file name from the user's file name (never used as-is: review N2). */
export function safeName(original: string, index: number) {
  const stem = original.replace(/\.[^./\\]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 80);
  return `${String(index).padStart(2, "0")}_${stem || "document"}.pdf`;
}

async function download(storage: Storage, key: string, to: string) {
  const file = await storage.get(key);
  if (!file) throw new Error("input file missing in storage");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = file.stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error("input file larger than 25 MB");
    }
    chunks.push(value);
  }
  await writeFile(to, Buffer.concat(chunks), { flag: "wx" });
}

export async function processNeutraliseJob(db: Db, storage: Storage, job: Job) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmc-job-"));
  try {
    const entity = await getEntity(db, job.entity);
    if (!entity) return failJob(db, job, null, `[worker] no details for entity ${job.entity}; an admin adds them under Settings > Entities`);

    const inDir = path.join(dir, "in");
    const outDir = path.join(dir, "out");
    await mkdir(inDir);
    await mkdir(outDir);
    const supplier = path.join(inDir, safeName(job.supplierFile.filename, 0));
    await download(storage, job.supplierFile.key, supplier);
    const inputs = [supplier];
    for (const [i, f] of job.commercialFiles.entries()) {
      const p = path.join(inDir, safeName(f.filename, i + 1));
      await download(storage, f.key, p);
      inputs.push(p);
    }
    const entityJson = path.join(dir, "entity.json");
    await writeFile(entityJson, JSON.stringify(engineEntityJson(entity)), "utf8");

    const run = await runPython(
      engineArgv({ inputs, outDir, entityJson, workDir: dir, route: job.route, productName: job.productName, fileNr: job.fileNr, batch: job.batch }),
      dir,
    );
    if (run.code !== 0 && run.code !== 2) return failJob(db, job, run.code, run.log);

    const names = (await readdir(outDir)).filter((n) => n.toLowerCase().endsWith(".docx"));
    if (!names.length) return failJob(db, job, run.code, `${run.log}\n[worker] the engine wrote no document`);

    const source = await readFile(supplier);
    const drafts: Draft[] = [];
    for (const docxName of names) {
      const stem = docxName.slice(0, -5);
      const m = NAME_RE.exec(stem);
      if (!m) return failJob(db, job, run.code, `${run.log}\n[worker] unexpected output name: ${stem}`);
      const pdfName = `${stem}.pdf`;
      const pdf = await readFile(path.join(outDir, pdfName)).catch(() => null);

      const docxKey = newUploadKey("docx");
      await storage.put(docxKey, await readFile(path.join(outDir, docxName)), DOCX);
      let pdfKey: string | null = null;
      if (pdf) {
        pdfKey = newUploadKey("pdf");
        await storage.put(pdfKey, pdf, PDF);
      }
      // Each document keeps its own copy of the supplier original (one file, one document).
      const sourceKey = newUploadKey("source");
      await storage.put(sourceKey, source, PDF);

      drafts.push({
        name: stem,
        type: (m[2] === "COA" ? "COA" : m[2] === "MSDS" ? "MSDS" : "TDS") as DocType,
        entity: m[1] as Entity,
        docxKey,
        docxFilename: docxName,
        pdfKey,
        pdfFilename: pdf ? pdfName : null,
        sourceKey,
        sourceFilename: job.supplierFile.filename,
        yellow: !pdf,
      });
    }
    await saveDrafts(db, job, drafts, run.code, run.log);
  } catch (err) {
    await failJob(db, job, null, cleanLog(`[worker] ${err instanceof Error ? err.message : "unexpected error"}`, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
