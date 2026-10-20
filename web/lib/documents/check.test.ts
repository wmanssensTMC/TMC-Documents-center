import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { documents, feedback, jobs } from "../db/schema";
import { newUploadKey } from "../files";
import type { Storage } from "../storage";
import { approveDraft, CheckError, finalName, makeFinal, rejectDraft, ReplaceConfirmError, requestFinalise, shownValues } from "./check";

const kars: Actor = { email: "kars@transmare.com", name: "Kars", role: "user" };
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const meta = { productName: "Sodium Benzoate", fileNr: "840.S0999", batch: "SB-1" };

let db: Db;
let files: Map<string, Uint8Array>;
const storage: Storage = {
  mode: "local",
  put: async (k, d) => void files.set(k, d),
  get: async () => null,
  head: async (k) => (files.has(k) ? { bytes: files.get(k)!, size: files.get(k)!.length } : null),
};

async function draft(over: Partial<typeof documents.$inferInsert> = {}) {
  const [row] = await db
    .insert(documents)
    .values({
      name: "TMC_COA_840.S0999_Sodium_Benzoate_SB-1",
      type: "COA",
      status: "To check",
      docxKey: newUploadKey("docx"),
      docxFilename: "TMC_COA_840.S0999_Sodium_Benzoate_SB-1.docx",
      sourceKey: newUploadKey("source"),
      sourceFilename: "supplier.pdf",
      yellowParts: [
        { id: "y0", text: "PRODUCTNAME", context: "Product: PRODUCTNAME" },
        { id: "y1", text: "01/09/2O29", context: "Expiry 01/09/2O29" },
      ],
      createdBy: kars.email,
      ...over,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  db = await createPgliteDb();
  files = new Map();
});

describe("finalise request (on-screen editor)", () => {
  it("refuses while any yellow part is not confirmed", async () => {
    const d = await draft();
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes: { y0: { value: "Sodium Benzoate", confirmed: true } } }),
    ).rejects.toThrow(/confirm every yellow part/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("queues a finalise job and keeps every decision as feedback", async () => {
    const d = await draft();
    await requestFinalise(db, storage, kars, d.id, {
      mode: "editor",
      metadata: meta,
      fixes: { y0: { value: "Sodium Benzoate", confirmed: true }, y1: { value: "01/09/2O29", confirmed: true } },
    });
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ kind: "finalise", state: "queued", documentId: d.id, createdBy: kars.email });
    const fb = await db.select().from(feedback);
    expect(fb.map((f) => [f.partId, f.kind, f.before, f.after])).toEqual([
      ["y0", "corrected", "PRODUCTNAME", "Sodium Benzoate"],
      ["y1", "confirmed", "01/09/2O29", "01/09/2O29"],
    ]);
    // the draft itself is untouched until the worker finalises it
    expect((await db.select().from(documents))[0].status).toBe("To check");
  });

  it("refuses a second finalise while one is open, unknown parts and missing product name", async () => {
    const d = await draft();
    const fixes = { y0: { value: "a", confirmed: true }, y1: { value: "b", confirmed: true } };
    await requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes });
    await expect(requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes })).rejects.toThrow(
      /already being finalised/,
    );
    const d2 = await draft({ name: "TMC_COA_other" });
    await expect(
      requestFinalise(db, storage, kars, d2.id, { mode: "editor", metadata: meta, fixes: { ...fixes, y7: { value: "x", confirmed: true } } }),
    ).rejects.toThrow(/unknown yellow part/);
    await expect(
      requestFinalise(db, storage, kars, d2.id, { mode: "editor", metadata: { ...meta, productName: " " }, fixes }),
    ).rejects.toThrow(CheckError);
  });

  it("Word upload: only a real Word file under its own key", async () => {
    const d = await draft();
    const bad = newUploadKey("docx");
    files.set(bad, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0, 0, 0])); // a PDF
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "upload", metadata: meta, docx: { key: bad, filename: "x.docx" } }),
    ).rejects.toThrow(/not a Word document/);
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "upload", metadata: meta, docx: { key: newUploadKey("pdf"), filename: "x" } }),
    ).rejects.toThrow(/upload the checked Word/);
    const good = newUploadKey("docx");
    files.set(good, DOCX);
    await requestFinalise(db, storage, kars, d.id, { mode: "upload", metadata: meta, docx: { key: good, filename: "checked.docx" } });
    expect((await db.select().from(feedback))[0]).toMatchObject({ kind: "word_upload", after: "checked.docx" });
  });
});

describe("finalise rules from the security review", () => {
  it("every part needs its own confirmation (L1)", async () => {
    const d = await draft();
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes: { y0: { value: "a" }, y1: { value: "b" } } }),
    ).rejects.toThrow(/confirm every yellow part/);
  });

  it("values are kept exactly as typed: no trimming (M1)", async () => {
    const d = await draft({ yellowParts: [{ id: "y0", text: " mg/L", context: "Unit mg/L" }] });
    await requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes: { y0: { value: " mg/L", confirmed: true } } });
    const [job] = await db.select().from(jobs);
    expect(job.payload).toMatchObject({ fixes: { y0: { value: " mg/L" } } });
    expect((await db.select().from(feedback))[0].kind).toBe("confirmed");
  });

  it("a part too long for the screen must be checked in Word (M1)", async () => {
    const d = await draft({ yellowParts: [{ id: "y0", text: "x".repeat(500), context: "", truncated: true }] });
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes: { y0: { value: "x".repeat(500), confirmed: true } } }),
    ).rejects.toThrow(/check it in Word/);
  });

  it("invisible characters are refused (I1)", async () => {
    const d = await draft({ yellowParts: [{ id: "y0", text: "a", context: "" }] });
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: meta, fixes: { y0: { value: "a‮b", confirmed: true } } }),
    ).rejects.toThrow(CheckError);
  });

  it("approve and reject wait while a finalise is open; the database allows only one open finalise (L3)", async () => {
    const d = await draft({ yellowParts: [], pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf" });
    await db.insert(jobs).values({ kind: "finalise", documentId: d.id, createdBy: kars.email });
    await expect(approveDraft(db, kars, d.id, meta)).rejects.toThrow(/being finalised/);
    await expect(rejectDraft(db, kars, d.id, "wrong document")).rejects.toThrow(/being finalised/);
    await expect(db.insert(jobs).values({ kind: "finalise", documentId: d.id, createdBy: kars.email })).rejects.toThrow();
  });
});

describe("approve and reject", () => {
  it("approve: goes through the worker, which checks the details are printed in the document", async () => {
    const d = await draft({ yellowParts: [], pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf" });
    await approveDraft(db, kars, d.id, meta);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ kind: "finalise", state: "queued", documentId: d.id, payload: { mode: "approve", metadata: meta } });
    expect((await db.select().from(documents))[0].status).toBe("To check"); // never Final by itself
  });

  it("becoming Final supersedes the previous Final of the same name", async () => {
    const pdf = () => ({ pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf", docxKey: newUploadKey("docx"), docxFilename: "x.docx" });
    const final = (id: string, f: ReturnType<typeof pdf>) =>
      db.transaction(async (tx) => makeFinal(tx, kars, (await tx.select().from(documents).where(eq(documents.id, id)))[0], f, meta));
    const first = await draft({ yellowParts: [] });
    expect(await final(first.id, pdf())).toEqual({ version: 1, supersededVersion: null });
    const second = await draft({ yellowParts: [] });
    expect(await final(second.id, pdf())).toEqual({ version: 2, supersededVersion: 1 });
    const rows = await db.select().from(documents);
    expect(rows.find((r) => r.id === first.id)?.status).toBe("Superseded");
    expect(rows.find((r) => r.id === second.id)).toMatchObject({ status: "Final", approvedBy: kars.email, productName: "Sodium Benzoate" });
  });
});

describe("file name follows the details (Willem 19/10)", () => {
  it("the name is made from the checked details by the naming rule", () => {
    expect(finalName({ type: "COA", entity: "TMC" }, meta)).toBe("TMC_COA_840.S0999_Sodium_Benzoate_SB-1");
    expect(finalName({ type: "MSDS", entity: "TMC" }, meta)).toBe("TMC_MSDS_Sodium_Benzoate");
    expect(() => finalName({ type: "TDS", entity: "TMC" }, { ...meta, productName: "???" })).toThrow(/valid file name/);
  });

  it("a changed product name renames the document when it becomes Final", async () => {
    const d = await draft({ yellowParts: [], name: "TMC_COA_840.S0999_Old_Name_SB-1" });
    const files = { pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf", docxKey: newUploadKey("docx"), docxFilename: "x.docx" };
    await db.transaction(async (tx) => makeFinal(tx, kars, d, files, meta));
    expect((await db.select().from(documents))[0].name).toBe("TMC_COA_840.S0999_Sodium_Benzoate_SB-1");
  });

  it("the values in the name must be printed: COA all three, MSDS/TDS the product", () => {
    expect(shownValues({ type: "COA", entity: "TMC" }, meta)).toEqual([
      ["product name", "Sodium Benzoate"],
      ["dossier", "840.S0999"],
      ["batch", "SB-1"],
    ]);
    expect(shownValues({ type: "MSDS", entity: "TMC" }, { ...meta, fileNr: null })).toEqual([["product name", "Sodium Benzoate"]]);
  });

  it("a new name that lands on another document's Final needs the person's explicit ok (review M1)", async () => {
    const other = await draft({ status: "Final", version: 1, productName: "Sodium Benzoate", yellowParts: [], pdfKey: newUploadKey("pdf"), pdfFilename: "a.pdf" });
    const d = await draft({ yellowParts: [], name: "TMC_COA_840.S0999_Old_Name_SB-1", pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf" });
    await expect(approveDraft(db, kars, d.id, meta)).rejects.toThrow(ReplaceConfirmError);
    expect(await db.select().from(jobs)).toHaveLength(0);
    await approveDraft(db, kars, d.id, meta, true);
    expect((await db.select().from(jobs))[0].payload).toMatchObject({ mode: "approve", replaces: other.id });
    // checked again when it becomes Final: without the ok, nothing is replaced
    const files = { pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf", docxKey: newUploadKey("docx"), docxFilename: "x.docx" };
    await expect(db.transaction(async (tx) => makeFinal(tx, kars, d, files, meta))).rejects.toThrow(ReplaceConfirmError);
    expect(await db.transaction(async (tx) => makeFinal(tx, kars, d, files, meta, other.id))).toEqual({ version: 2, supersededVersion: 1 });
  });

  it("the batch the document was made for cannot be changed", async () => {
    const d = await draft({ yellowParts: [], batch: "SB-1", pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf" });
    await expect(approveDraft(db, kars, d.id, { ...meta, batch: "SB-2" })).rejects.toThrow(/cannot be changed/);
    await expect(
      requestFinalise(db, storage, kars, d.id, { mode: "editor", metadata: { ...meta, batch: "" }, fixes: {} }),
    ).rejects.toThrow(/cannot be changed/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("approve refuses a draft with yellow parts or without PDF", async () => {
    const yellow = await draft({ pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf" });
    await expect(approveDraft(db, kars, yellow.id, meta)).rejects.toThrow(/yellow parts/);
    const noPdf = await draft({ name: "TMC_COA_b", yellowParts: [] });
    await expect(approveDraft(db, kars, noPdf.id, meta)).rejects.toThrow(/no PDF/);
  });

  it("reject: status Rejected, reason kept as feedback, job closed when nothing is left", async () => {
    const [job] = await db
      .insert(jobs)
      .values({ kind: "neutralise", state: "to_check", createdBy: kars.email, supplierFile: { key: newUploadKey("input"), filename: "s.pdf" } })
      .returning();
    const d = await draft({ jobId: job.id });
    await expect(rejectDraft(db, kars, d.id, "x")).rejects.toThrow(/short reason/);
    await rejectDraft(db, kars, d.id, "Wrong table read: assay missing");
    expect((await db.select().from(documents))[0]).toMatchObject({ status: "Rejected", rejectedReason: "Wrong table read: assay missing" });
    expect((await db.select().from(feedback))[0]).toMatchObject({ kind: "rejected" });
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].state).toBe("done");
    await expect(approveDraft(db, kars, d.id, meta)).rejects.toThrow(/Rejected/);
  });
});
