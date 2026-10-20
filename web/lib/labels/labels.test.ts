import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { auditLog, documents, jobs } from "../db/schema";
import { approveDraft, CheckError, finalName, makeFinal, requestFinalise, shownValues } from "../documents/check";
import type { Storage } from "../storage";
import { newUploadKey } from "../files";
import { MAX_OPEN_JOBS_PER_USER } from "../jobs";
import { createLabelJob, finalCoas, labelInput, LabelError, type LabelInput } from "./index";
import { LABEL_TEMPLATES } from "./templates";

const warre: Actor = { email: "warre@transmare.com", name: "Warre", role: "user" };
const form: LabelInput = { template: "sample", language: "FR", entity: "TMC", productName: "Betaine AI test", batch: "BT-3877", fileNr: "840.S0850" };

const metadata = { productName: "Betaine AI test", fileNr: "840.S0850", batch: "BT-3877" };

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
});

/** A label draft as the worker stores it, made from the given template. */
async function labelDraft(template: string, sample = template === "sample") {
  const [job] = await db
    .insert(jobs)
    .values({ kind: "label", state: "to_check", ...metadata, label: { template, language: "FR", fields: {}, sample }, createdBy: warre.email })
    .returning();
  const name = "TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_FR";
  const [doc] = await db
    .insert(documents)
    .values({
      name,
      type: "LABEL",
      language: "FR",
      status: "To check",
      ...metadata,
      docxKey: newUploadKey("docx"),
      docxFilename: `${name}.docx`,
      pdfKey: newUploadKey("pdf"),
      pdfFilename: `${name}.pdf`,
      yellowParts: [],
      createdBy: warre.email,
      jobId: job.id,
    })
    .returning();
  return doc;
}


describe("label form", () => {
  it("accepts the values and turns a decimal comma into a point", () => {
    const r = labelInput.parse({ ...form, netWeight: "25,5", productionDate: "2026-03-01" });
    expect(r).toMatchObject({ netWeight: "25.5", productionDate: "2026-03-01", expiryDate: "" });
  });

  it("refuses placeholders, option-like text, bad dates and numbers, unknown templates and languages", () => {
    for (const bad of [
      { batch: "{{t.batch}}" },
      { productName: "-x" },
      { productionDate: "01/03/2026" },
      { netWeight: "25 kg" },
      { template: "../TMC_COA_template" },
      { language: "AR" },
      { batch: "" },
    ]) {
      expect(labelInput.safeParse({ ...form, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("label job", () => {
  it("files a label job with the form values and no supplier name", async () => {
    const id = await createLabelJob(db, warre, { ...form, netWeight: "25", supplierName: "ACME" } as LabelInput);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({ kind: "label", state: "queued", productName: "Betaine AI test", batch: "BT-3877", fileNr: "840.S0850", supplierName: null });
    expect(job.label).toEqual({ template: "sample", language: "FR", fields: { netWeight: "25" }, sample: true });
    const [audit] = await db.select().from(auditLog);
    expect(audit).toMatchObject({ action: "job.created", actor: warre.email });
  });

  it("refuses an entity without details (an address is never invented)", async () => {
    await expect(createLabelJob(db, warre, { ...form, entity: "TMCGULF" })).rejects.toThrow(LabelError);
  });

  it("refuses a label job when the person already has the maximum of open jobs (abuse limit)", async () => {
    const open = Array.from({ length: MAX_OPEN_JOBS_PER_USER }, () => ({ kind: "neutralise" as const, createdBy: warre.email }));
    await db.insert(jobs).values(open);
    await expect(createLabelJob(db, warre, form)).rejects.toThrow(/many documents waiting/);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "label"))).toHaveLength(0);
  });

  it("refuses an unknown template and text with control characters before anything is filed", async () => {
    for (const bad of [{ template: "TMC_LABEL_SAMPLE.docx" }, { productName: "Betaine\u202Etset" }, { batch: "BT\n3877" }, { productName: "x".repeat(201) }]) {
      await expect(createLabelJob(db, warre, { ...form, ...bad }), JSON.stringify(bad)).rejects.toThrow(LabelError);
    }
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("a label job always carries its label details (database check)", async () => {
    await expect(db.insert(jobs).values({ kind: "label", createdBy: warre.email })).rejects.toThrow();
  });
});

describe("label naming and approval", () => {
  it("names the label with its language and checks product and batch are printed", () => {
    expect(finalName({ type: "LABEL", entity: "TMC", language: "FR" }, metadata)).toBe("TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_FR");
    expect(shownValues({ type: "LABEL", entity: "TMC" }, metadata)).toEqual([
      ["product name", "Betaine AI test"],
      ["batch", "BT-3877"],
    ]);
  });

  it("a SAMPLE label can never become Final", async () => {
    const doc = await labelDraft("sample");
    await expect(approveDraft(db, warre, doc.id, metadata)).rejects.toThrow(/SAMPLE template/);
    const files = { pdfKey: doc.pdfKey!, pdfFilename: doc.pdfFilename!, docxKey: doc.docxKey!, docxFilename: doc.docxFilename! };
    await expect(db.transaction((tx) => makeFinal(tx, warre, doc, files, metadata))).rejects.toThrow(CheckError);
    expect((await db.select().from(documents))[0].status).toBe("To check");
  });

  it("a label is approved as it is: no edited or uploaded Word file (security M1)", async () => {
    const doc = await labelDraft("sample");
    const storage = { mode: "local", put: async () => {}, get: async () => null, head: async () => null } as Storage;
    await expect(requestFinalise(db, storage, warre, doc.id, { mode: "editor", metadata, fixes: {} })).rejects.toThrow(/approved as it is/);
    await expect(requestFinalise(db, storage, warre, doc.id, { mode: "upload", metadata, docx: { key: "x", filename: "x.docx" } })).rejects.toThrow(/approved as it is/);
  });

  describe("with a real template", () => {
    beforeEach(() => {
      LABEL_TEMPLATES.push({ id: "test-real", name: "test", file: "TMC_LABEL_TEST.docx", sample: false });
    });
    afterEach(() => {
      LABEL_TEMPLATES.splice(LABEL_TEMPLATES.findIndex((t) => t.id === "test-real"), 1);
    });

    it("a label made as a sample stays a sample, whatever the list says later (security M3)", async () => {
      const doc = await labelDraft("test-real", true);
      await expect(approveDraft(db, warre, doc.id, metadata)).rejects.toThrow(/SAMPLE template/);
    });

    it("keeps the dossier and batch of the label (security L2)", async () => {
      const doc = await labelDraft("test-real");
      await expect(approveDraft(db, warre, doc.id, { ...metadata, fileNr: "840.S9999" })).rejects.toThrow(/dossier of a label/);
    });

    it("is approved like any other document and supersedes the previous Final", async () => {
      const files = (d: typeof documents.$inferSelect) => ({ pdfKey: d.pdfKey!, pdfFilename: d.pdfFilename!, docxKey: d.docxKey!, docxFilename: d.docxFilename! });
      const first = await labelDraft("test-real");
      await approveDraft(db, warre, first.id, metadata);
      expect((await db.select().from(jobs).where(eq(jobs.kind, "finalise")))[0]).toMatchObject({ documentId: first.id });
      await db.transaction((tx) => makeFinal(tx, warre, first, files(first), metadata));
      const second = await labelDraft("test-real");
      await db.transaction((tx) => makeFinal(tx, warre, second, files(second), metadata));
      const rows = await db.select().from(documents).orderBy(documents.version);
      expect(rows.map((r) => [r.name, r.status, r.version])).toEqual([
        ["TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_FR", "Superseded", 1],
        ["TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_FR", "Final", 2],
      ]);
    });
  });
});

describe("start from a COA", () => {
  it("lists Final COAs only, without the supplier name", async () => {
    const base = { type: "COA" as const, productName: "P", batch: "B1", supplierName: "ACME", createdBy: warre.email };
    await db.insert(documents).values([
      { ...base, name: "TMC_COA_P_B1", status: "Final", version: 1, pdfKey: newUploadKey("pdf") },
      { ...base, name: "TMC_COA_P_B2", status: "To check" },
    ]);
    const rows = await finalCoas(db);
    expect(rows.map((r) => r.name)).toEqual(["TMC_COA_P_B1"]);
    expect(rows[0]).not.toHaveProperty("supplierName");
  });
});
