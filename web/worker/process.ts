// One neutralise job: fetch the inputs, run the engine, store its drafts. Exit code 1 =
// failure, nothing is stored (ENGINE.md: a failed run has nothing usable).
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "../lib/db";
import type { DocType, Entity, Job, YellowPart } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { documents } from "../lib/db/schema";
import { finalName, shownValues } from "../lib/documents/check";
import { engineEntityJson, getEntity } from "../lib/entities";
import { MAX_FILE_BYTES, newUploadKey } from "../lib/files";
import { failJob, saveDrafts, saveFinal, type Draft } from "../lib/jobs/worker-state";
import { nameParts, plainName } from "../lib/naming";
import type { Storage } from "../lib/storage";
import { cleanLog, engineArgv, finaliseArgv, runPython, yellowArgv } from "./engine";

export { plainName };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = "application/pdf";
const SAFE_TEXT = /^[^\u0000-\u001f\u007f\u2028\u2029\p{Cf}]{0,100}$/u;

/** The batch the engine says this document is for (COA route, <stem>.meta.json). */
async function engineBatch(outDir: string, stem: string): Promise<string | null> {
  const raw = await readFile(path.join(outDir, `${stem}.meta.json`), "utf8").catch(() => null);
  if (!raw) return null;
  const batch = (JSON.parse(raw) as { batch?: unknown }).batch;
  return typeof batch === "string" && batch.trim() && SAFE_TEXT.test(batch.trim()) ? batch.trim() : null;
}

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
  const supplierFile = job.supplierFile;
  if (!supplierFile) return failJob(db, job, null, "[worker] neutralise job without a supplier document");
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmc-job-"));
  try {
    const entity = await getEntity(db, job.entity);
    if (!entity) return failJob(db, job, null, `[worker] no details for entity ${job.entity}; an admin adds them under Settings > Entities`);

    const inDir = path.join(dir, "in");
    const outDir = path.join(dir, "out");
    await mkdir(inDir);
    await mkdir(outDir);
    const supplier = path.join(inDir, safeName(supplierFile.filename, 0));
    await download(storage, supplierFile.key, supplier);
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
      const m = nameParts(stem);
      if (!m || !plainName(stem)) return failJob(db, job, run.code, `${run.log}\n[worker] unexpected output name: ${stem}`);
      const pdfName = `${stem}.pdf`;
      const docxPath = path.join(outDir, docxName);
      // Always read the yellow parts, also when the engine made a PDF (review N5): any yellow
      // part means a draft to check, and its PDF is not kept.
      const listed = await runPython(yellowArgv("list", docxPath), dir, { keepStdout: true });
      if (listed.code !== 0) {
        return failJob(db, job, run.code, [run.log, "[worker] could not read the yellow parts", listed.log].join("\n"));
      }
      const yellowParts: YellowPart[] = parseYellowParts(listed.stdout);
      const pdf = yellowParts.length ? null : await readFile(path.join(outDir, pdfName)).catch(() => null);

      const docxKey = newUploadKey("docx");
      await storage.put(docxKey, await readFile(docxPath), DOCX);
      let pdfKey: string | null = null;
      if (pdf) {
        pdfKey = newUploadKey("pdf");
        await storage.put(pdfKey, pdf, PDF);
      }
      // Each document keeps its own copy of the supplier original (one file, one document).
      const sourceKey = newUploadKey("source");
      await storage.put(sourceKey, source, PDF);

      // No real PDF yet: a DRAFT preview for the check screen.
      let previewKey: string | null = null;
      if (!pdf) {
        const previewPath = path.join(dir, `${stem}.preview.pdf`);
        const preview = await runPython(yellowArgv("preview", docxPath, previewPath), dir);
        if (preview.code === 0) {
          previewKey = newUploadKey("preview");
          await storage.put(previewKey, await readFile(previewPath), PDF);
        } // no preview: the check screen offers the Word download instead
      }

      drafts.push({
        name: stem,
        type: (m[2] === "COA" ? "COA" : m[2] === "MSDS" ? "MSDS" : "TDS") as DocType,
        entity: m[1] as Entity,
        docxKey,
        docxFilename: docxName,
        pdfKey,
        pdfFilename: pdf ? pdfName : null,
        sourceKey,
        sourceFilename: supplierFile.filename,
        yellow: !pdf,
        yellowParts,
        previewKey,
        batch: await engineBatch(outDir, stem),
      });
    }
    await saveDrafts(db, job, drafts, run.code, run.log);
  } catch (err) {
    await failJob(db, job, null, cleanLog(`[worker] ${err instanceof Error ? err.message : "unexpected error"}`, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Output of yellow.py list, checked: ids y0.., texts capped. Anything odd = no parts. */
export function parseYellowParts(stdout: string): YellowPart[] {
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) throw new Error("yellow list is not a list");
  return raw.slice(0, 500).map((p, i) => {
    const o = p as Record<string, unknown>;
    if (o.id !== `y${i}` || typeof o.text !== "string" || typeof o.context !== "string") throw new Error("bad yellow list");
    return { id: o.id, text: o.text.slice(0, 500), context: o.context.slice(0, 300), truncated: o.truncated === true };
  });
}

/**
 * Finalise a checked draft: write in the confirmed fixes (or take the uploaded Word file), then
 * the engine's own --finalise renders the PDF and refuses while anything is still yellow.
 */
export async function processFinaliseJob(db: Db, storage: Storage, job: Job) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmc-job-"));
  try {
    const payload = job.payload;
    if (!job.documentId || !payload) return failJob(db, job, null, "[worker] finalise job without document");
    const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId));
    if (!doc || doc.status !== "To check") return failJob(db, job, null, "[worker] the document is not waiting for a check");
    // The name comes from the checked details by the naming rule (Willem 19/10): name, content
    // and library details always agree.
    const name = finalName(doc, payload.metadata);
    if (!plainName(name)) return failJob(db, job, null, "[worker] unexpected document name");
    const stays = "[worker] not finalised: the document stays waiting for a check";

    const outDir = path.join(dir, "final");
    await mkdir(outDir);
    const finalDocx = path.join(outDir, `${name}.docx`);
    let approved: { pdfKey: string; docxKey: string } | null = null;
    if (payload.mode === "editor") {
      if (!doc.docxKey) return failJob(db, job, null, "[worker] the draft has no Word file");
      const draft = path.join(dir, "draft.docx");
      await download(storage, doc.docxKey, draft);
      const fixes = path.join(dir, "fixes.json");
      await writeFile(fixes, JSON.stringify(payload.fixes), "utf8");
      const applied = await runPython(yellowArgv("apply", draft, fixes, finalDocx), dir);
      if (applied.code !== 0) return failJob(db, job, applied.code, `[worker] the corrections could not be written in\n${applied.log}`);
    } else if (payload.mode === "approve") {
      if (!doc.docxKey || !doc.pdfKey) return failJob(db, job, null, "[worker] the draft has no Word file or PDF");
      approved = { pdfKey: doc.pdfKey, docxKey: doc.docxKey };
      await download(storage, doc.docxKey, finalDocx);
    } else {
      await download(storage, payload.docx.key, finalDocx);
    }

    // Before anything is rendered: the Word file must be safe to process, must not name the
    // supplier (reviews M2/M3) and must print every value its name is made of.
    const forbid = path.join(dir, "forbid.json");
    await writeFile(forbid, JSON.stringify([doc.supplierName].filter(Boolean)), "utf8");
    const shown = path.join(dir, "shown.json");
    await writeFile(shown, JSON.stringify(shownValues(doc, payload.metadata)), "utf8");
    const safe = await runPython(yellowArgv("check", finalDocx, forbid, shown), dir);
    if (safe.code !== 0) return failJob(db, job, safe.code, `${safe.log}\n${stays}`);

    const files = { pdfFilename: `${name}.pdf`, docxFilename: `${name}.docx` };
    if (approved) {
      // The engine's own PDF of this same Word file: only the file names change.
      await saveFinal(db, job, { ...files, ...approved }, safe.log);
      return;
    }
    const run = await runPython(finaliseArgv(finalDocx), dir);
    const pdf = run.code === 0 ? await readFile(path.join(outDir, files.pdfFilename)).catch(() => null) : null;
    if (!pdf) return failJob(db, job, run.code, `${run.log}\n${stays}`);

    let docxKey: string;
    if (payload.mode === "upload") {
      docxKey = payload.docx.key; // the person's checked Word file is the master
    } else {
      docxKey = newUploadKey("docx");
      await storage.put(docxKey, await readFile(finalDocx), DOCX);
    }
    const pdfKey = newUploadKey("pdf");
    await storage.put(pdfKey, pdf, PDF);
    await saveFinal(db, job, { ...files, pdfKey, docxKey }, run.log);
  } catch (err) {
    await failJob(db, job, null, cleanLog(`[worker] ${err instanceof Error ? err.message : "unexpected error"}`, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
