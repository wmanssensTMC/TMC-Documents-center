// One neutralise job: fetch the inputs, run the engine, store its drafts. Exit code 1 =
// failure, nothing is stored (ENGINE.md: a failed run has nothing usable).
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import os from "node:os";
import path from "node:path";
import type { Db } from "../lib/db";
import type { DocType, Entity, Job, YellowPart } from "../lib/db/schema";
import { eq } from "drizzle-orm";
import { documents } from "../lib/db/schema";
import { CHANGES_MARK, parseChanges, type Change } from "../lib/documents/changes";
import { finalName, shownValues } from "../lib/documents/check";
import { engineEntityJson, getEntity } from "../lib/entities";
import { MAX_FILE_MB, maxFileBytes, newUploadKey } from "../lib/files";
import { failJob, saveDrafts, saveFinal, type Draft } from "../lib/jobs/worker-state";
import { labelTemplate } from "../lib/labels/templates";
import { fileStem, nameParts, plainName } from "../lib/naming";
import type { Storage } from "../lib/storage";
import { aiEngineEnv, engineAi, logAiUsage, readAiUsage } from "./ai";
import { cleanLog, engineArgv, finaliseArgv, labelArgv, runPython, yellowArgv } from "./engine";

export { plainName };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF = "application/pdf";
const JSON_TYPE = "application/json";
/** A bigger view (pictures included) is not offered: the browser would struggle with it. */
const MAX_VIEW_BYTES = 12 * 1024 * 1024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f\u2028\u2029\p{Cf}]{0,100}$/u;

/** The batch the engine says this document is for (COA route, <stem>.meta.json). */
async function engineBatch(outDir: string, stem: string, isCoa: boolean): Promise<string | null> {
  const raw = await readFile(path.join(outDir, `${stem}.meta.json`), "utf8").catch(() => null);
  if (!raw) {
    // the COA route always writes it: without it the batch lock would fall away (review R1)
    if (isCoa) throw new Error("the engine wrote no batch details for a COA");
    return null;
  }
  let batch: unknown;
  try {
    batch = (JSON.parse(raw) as { batch?: unknown }).batch;
  } catch {
    throw new Error("the engine wrote unreadable batch details");
  }
  if (batch === "") return null; // the engine found no batch: it is marked yellow in the document
  // anything else odd stops the job: the batch lock must never fall away silently (review L3)
  if (typeof batch !== "string" || !batch.trim() || !SAFE_TEXT.test(batch.trim())) throw new Error("the engine wrote an unusable batch");
  return batch.trim();
}

/** A safe local file name from the user's file name (never used as-is: review N2). */
export function safeName(original: string, index: number) {
  const stem = original.replace(/\.[^./\\]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 80);
  return `${String(index).padStart(2, "0")}_${stem || "document"}.pdf`;
}

async function download(storage: Storage, key: string, to: string) {
  const file = await storage.get(key);
  if (!file) throw new Error("input file missing in storage");
  // streamed to disk with a byte count, never held in memory whole (security review M5)
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxFileBytes("input")) return done(new Error(`input file larger than ${MAX_FILE_MB.input} MB`));
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(file.stream as WebReadableStream<Uint8Array>), cap, createWriteStream(to, { flags: "wx" }));
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

    // AI reader (27/10): only on this run, only when on and under today's limit. The supplier name
    // a person typed goes along only as a block list for AI values (Willem 27/10), never printed.
    const aiEnv = await aiEngineEnv(db);
    if (aiEnv.AI_READER && job.supplierName?.trim()) {
      const forbid = path.join(dir, "ai_forbid.json");
      await writeFile(forbid, JSON.stringify([job.supplierName.trim()]), "utf8");
      aiEnv.AI_READER_FORBID = forbid;
    }
    const run = await runPython(
      engineArgv({ inputs, outDir, entityJson, workDir: dir, route: job.route, productName: job.productName, fileNr: job.fileNr, batch: job.batch }),
      dir,
      { env: aiEnv },
    );
    await logAiUsage(db, job, await readAiUsage(outDir)); // counted also when the job fails below
    if (run.code !== 0 && run.code !== 2) return failJob(db, job, run.code, run.log);

    const names = (await readdir(outDir)).filter((n) => n.toLowerCase().endsWith(".docx"));
    if (!names.length) return failJob(db, job, run.code, `${run.log}\n[worker] the engine wrote no document`);

    const source = await readFile(supplier);
    const drafts: Draft[] = [];
    for (const docxName of names) {
      const stem = docxName.slice(0, -5);
      const m = nameParts(stem);
      // the neutralizer never makes labels (review: a LABEL name here would be filed as a TDS)
      if (!m || !plainName(stem) || m[2] === "LABEL") return failJob(db, job, run.code, `${run.log}\n[worker] unexpected output name: ${stem}`);
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

      // The on-screen editor's view of this draft (own editor, Willem 20/10). Without it the
      // check screen offers the yellow-parts list and the Word download instead.
      let viewKey: string | null = null;
      const viewPath = path.join(dir, `${stem}.view.json`);
      const view = await runPython(yellowArgv("view", docxPath, viewPath), dir);
      const viewJson = view.code === 0 ? await readFile(viewPath).catch(() => null) : null;
      if (viewJson && viewJson.length <= MAX_VIEW_BYTES) {
        viewKey = newUploadKey("view");
        await storage.put(viewKey, viewJson, JSON_TYPE);
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
        viewKey,
        batch: await engineBatch(outDir, stem, m[2] === "COA"),
        ai: await engineAi(outDir, stem),
      });
    }
    await saveDrafts(db, job, drafts, run.code, run.log);
  } catch (err) {
    await failJob(db, job, null, cleanLog(`[worker] ${err instanceof Error ? err.message : "unexpected error"}`, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * One label: the engine fills the template with the form values and renders the PDF; its
 * provenance gate runs inside. The label waits for a person's approval like any draft.
 */
export async function processLabelJob(db: Db, storage: Storage, job: Job) {
  const label = job.label;
  if (!label) return failJob(db, job, null, "[worker] label job without label details");
  const template = labelTemplate(label.template); // never a path from the database
  if (!template) return failJob(db, job, null, "[worker] unknown label template");
  const dir = await mkdtemp(path.join(os.tmpdir(), "tmc-job-"));
  try {
    const entity = await getEntity(db, job.entity);
    if (!entity) return failJob(db, job, null, `[worker] no details for entity ${job.entity}; an admin adds them under Settings > Entities`);
    const packSize = label.fields.netWeight ? `${label.fields.netWeight}kg` : null;
    const name = fileStem({ type: "LABEL", entity: job.entity, productName: job.productName, fileNr: job.fileNr, batch: job.batch, packSize, language: label.language });
    if (!plainName(name)) return failJob(db, job, null, "[worker] these details do not give a valid file name");

    const outDir = path.join(dir, "out");
    await mkdir(outDir);
    const fieldsJson = path.join(dir, "fields.json");
    await writeFile(fieldsJson, JSON.stringify({ ...label.fields, productName: job.productName ?? "", batch: job.batch ?? "" }), "utf8");
    const entityJson = path.join(dir, "entity.json");
    await writeFile(entityJson, JSON.stringify(engineEntityJson(entity)), "utf8");

    const run = await runPython(labelArgv({ templateFile: template.file, fieldsJson, entityJson, language: label.language, name, outDir }), dir);
    if (run.code !== 0) return failJob(db, job, run.code, run.log); // only 0 is a label
    const docx = await readFile(path.join(outDir, `${name}.docx`)).catch(() => null);
    const pdf = await readFile(path.join(outDir, `${name}.pdf`)).catch(() => null);
    if (!docx || !pdf) return failJob(db, job, run.code, `${run.log}\n[worker] the engine wrote no label`);

    const docxKey = newUploadKey("docx");
    await storage.put(docxKey, docx, DOCX);
    const pdfKey = newUploadKey("pdf");
    await storage.put(pdfKey, pdf, PDF);
    await saveDrafts(
      db,
      job,
      [
        {
          name,
          type: "LABEL",
          entity: job.entity,
          docxKey,
          docxFilename: `${name}.docx`,
          pdfKey,
          pdfFilename: `${name}.pdf`,
          sourceKey: null,
          sourceFilename: null,
          yellow: false,
          yellowParts: [],
          previewKey: null,
          batch: job.batch,
          language: label.language,
          manufacturingDate: label.fields.productionDate || null,
          expiryOrRetestDate: label.fields.expiryDate || null,
          by: "label",
        },
      ],
      run.code,
      run.log,
    );
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
    let structural: Change[] = [];
    const draft = path.join(dir, "draft.docx");
    if (payload.mode === "editor") {
      if (!doc.docxKey) return failJob(db, job, null, "[worker] the draft has no Word file");
      await download(storage, doc.docxKey, draft);
      const fixes = path.join(dir, "fixes.json");
      await writeFile(fixes, JSON.stringify(payload.fixes), "utf8");
      const applied = await runPython(yellowArgv("apply", draft, fixes, finalDocx), dir);
      if (applied.code !== 0) return failJob(db, job, applied.code, `[worker] the corrections could not be written in\n${applied.log}`);
    } else if (payload.mode === "edited") {
      // Own editor (Willem 20/10): only the changed pieces of text come from the browser; they
      // are written into the engine's own draft, so its layout stays as it is.
      if (!doc.docxKey) return failJob(db, job, null, "[worker] the draft has no Word file");
      await download(storage, doc.docxKey, draft);
      const changes = path.join(dir, "edits.json");
      await writeFile(changes, JSON.stringify(payload.edits), "utf8");
      const applied = await runPython(yellowArgv("edit", draft, changes, finalDocx), dir, { keepStdout: true });
      if (applied.code !== 0) return failJob(db, job, applied.code, `[worker] the changes could not be written in\n${applied.log}\n${stays}`);
      structural = parseChanges(applied.stdout); // rows or columns taken out: always shown as a warning
    } else if (payload.mode === "approve") {
      if (!doc.docxKey || !doc.pdfKey) return failJob(db, job, null, "[worker] the draft has no Word file or PDF");
      if ((doc.yellowParts ?? []).length) return failJob(db, job, null, `[worker] the draft has yellow parts
${stays}`);
      approved = { pdfKey: doc.pdfKey, docxKey: doc.docxKey };
      await download(storage, doc.docxKey, finalDocx);
      // Hard rule 2, checked again on the file itself: nothing yellow becomes Final (review L1)
      const listed = await runPython(yellowArgv("list", finalDocx), dir, { keepStdout: true });
      if (listed.code !== 0 || parseYellowParts(listed.stdout).length) {
        return failJob(db, job, listed.code, `[worker] the Word file still has yellow parts
${stays}`);
      }
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

    // Edited on screen (Willem 19/10): every change is kept as feedback; a change that brings in
    // words or numbers not found in the supplier original is a warning the person must see.
    let edits: Change[] = [];
    if (payload.mode === "edited") {
      const listed = await runPython(yellowArgv("list", finalDocx), dir, { keepStdout: true });
      const left = listed.code === 0 ? parseYellowParts(listed.stdout).length : -1;
      if (left !== 0) {
        return failJob(db, job, listed.code, `[worker] ${left > 0 ? left : "some"} yellow part(s) still marked: check each one and remove its highlight\n${stays}`);
      }
      if (!doc.sourceKey) return failJob(db, job, null, "[worker] the supplier original is missing");
      const source = path.join(dir, "source.pdf");
      await download(storage, doc.sourceKey, source);
      const compared = await runPython(yellowArgv("changes", draft, finalDocx, source), dir, { keepStdout: true });
      if (compared.code !== 0) return failJob(db, job, compared.code, `[worker] the changes could not be compared\n${compared.log}`);
      // new words first: deleted rows must never push them out of view (review M1)
      edits = [...parseChanges(compared.stdout), ...structural];
      const warned = edits.filter((c) => c.unknown.length);
      if (warned.length && !payload.acceptChanges) {
        return failJob(db, job, null, [CHANGES_MARK + JSON.stringify(warned.slice(0, 20)), `[worker] ${warned.length} change(s) bring in words or numbers that are not in the supplier original: check them, then confirm to go on`, stays].join("\n"));
      }
    }

    const files = { pdfFilename: `${name}.pdf`, docxFilename: `${name}.docx` };
    // Layout (Willem 22/10): nothing over the TMC letterhead, nothing cut off; otherwise no Final.
    const layoutOk = async (pdfPath: string) => {
      const checked = await runPython(yellowArgv("layout", pdfPath, finalDocx), dir);
      return checked.code === 0 ? null : `${checked.log}\n${stays}`;
    };
    if (approved) {
      // The engine's own PDF of this same Word file: only the file names change.
      const enginePdf = path.join(dir, "engine.pdf");
      await download(storage, approved.pdfKey, enginePdf);
      const bad = await layoutOk(enginePdf);
      if (bad) return failJob(db, job, null, bad);
      await saveFinal(db, job, { ...files, ...approved }, safe.log);
      return;
    }
    const run = await runPython(finaliseArgv(finalDocx), dir);
    const pdf = run.code === 0 ? await readFile(path.join(outDir, files.pdfFilename)).catch(() => null) : null;
    if (!pdf) return failJob(db, job, run.code, `${run.log}\n${stays}`);
    const bad = await layoutOk(path.join(outDir, files.pdfFilename));
    if (bad) return failJob(db, job, null, bad);

    let docxKey: string;
    if (payload.mode === "upload") {
      docxKey = payload.docx.key; // the person's checked Word file is the master
    } else {
      docxKey = newUploadKey("docx");
      await storage.put(docxKey, await readFile(finalDocx), DOCX);
    }
    const pdfKey = newUploadKey("pdf");
    await storage.put(pdfKey, pdf, PDF);
    const feedbackRows = edits.map((c) => ({
      kind: "edited" as const,
      before: c.before,
      after: c.after,
      context: c.unknown.length ? `not in the original, accepted after the warning: ${c.unknown.join(" ")}`.slice(0, 300) : null,
    }));
    await saveFinal(db, job, { ...files, pdfKey, docxKey }, run.log, feedbackRows);
  } catch (err) {
    await failJob(db, job, null, cleanLog(`[worker] ${err instanceof Error ? err.message : "unexpected error"}`, dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
