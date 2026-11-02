// "Run again with the latest neutralizer" and the dossier overview (Willem 02/11).
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { auditLog, documents, jobs } from "../db/schema";
import { dossierFileNr, getDossierDocuments } from "../documents/dossier";
import { newUploadKey } from "../files";
import type { Storage } from "../storage";
import { canRerun, createJobs, JobError, listJobs, MAX_OPEN_JOBS_PER_USER, rerunJob, type JobInput } from "./index";
import { claimNextJob, failJob, saveDrafts, type Draft } from "./worker-state";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const willem: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
const dennis: Actor = { email: "dennis@transmare.com", name: "Dennis", role: "user" };

let db: Db;
let files: Map<string, Uint8Array>;
const storage: Storage = {
  mode: "local",
  put: async () => {},
  get: async () => null,
  head: async (key) => (files.has(key) ? { bytes: files.get(key)!, size: files.get(key)!.length } : null),
};

function input(name: string) {
  const key = newUploadKey("input");
  files.set(key, PDF);
  return { key, filename: name };
}

function job(over: Partial<JobInput> = {}): JobInput {
  return {
    route: "coa",
    entity: "TMC",
    productName: "Euxyl PE 9010",
    fileNr: "840.S0959",
    batch: "LOT2504280",
    supplierName: "Example Supplier BV",
    supplierFile: input("supplier coa.pdf"),
    commercialFiles: [input("pfi.pdf")],
    ...over,
  };
}

function draft(name: string): Draft {
  return {
    name,
    type: "COA",
    entity: "TMC",
    docxKey: newUploadKey("docx"),
    docxFilename: `${name}.docx`,
    pdfKey: null,
    pdfFilename: null,
    sourceKey: newUploadKey("source"),
    sourceFilename: "supplier coa.pdf",
    yellow: true,
    yellowParts: [{ id: "y0", text: "[not on the source - check]", context: "Lot / batch nr" }],
    previewKey: null,
  };
}

/** A neutralise job run to a "To check" draft, as the worker does it. */
async function madeDraft(over: Partial<JobInput> = {}, name = "TMC_COA_840.S0959_Euxyl_PE_9010") {
  await createJobs(db, storage, dennis, [job(over)]);
  const j = (await claimNextJob(db))!;
  await saveDrafts(db, j, [draft(name)], 2, "engine log");
  const [doc] = await db.select().from(documents).where(eq(documents.jobId, j.id));
  return { doc, job: j };
}

/** A complete Final, as the database demands (version, PDF, product name). */
const FINAL = { status: "Final" as const, version: 1, pdfKey: newUploadKey("pdf"), pdfFilename: "x.pdf", productName: "Euxyl PE 9010" };

const statusOf = async (id: string) => (await db.select().from(documents).where(eq(documents.id, id)))[0].status;

beforeEach(async () => {
  db = await createPgliteDb();
  files = new Map();
});

describe("run again", () => {
  it("files a new job with the same values and the same stored files, linked to the draft", async () => {
    const { doc, job: first } = await madeDraft();
    expect(await canRerun(db, doc)).toBe(true);
    const id = await rerunJob(db, storage, willem, doc.id);
    const [again] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(again).toMatchObject({
      kind: "neutralise",
      state: "queued",
      route: first.route,
      entity: first.entity,
      productName: "Euxyl PE 9010",
      fileNr: "840.S0959",
      batch: "LOT2504280",
      supplierName: "Example Supplier BV",
      supplierFile: first.supplierFile,
      commercialFiles: first.commercialFiles,
      rerunOf: doc.id,
      createdBy: willem.email, // anyone logged in may run a draft again
    });
    const audit = (await db.select().from(auditLog)).filter((a) => a.action === "document.rerun");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ documentId: doc.id, actor: willem.email });
    expect(await statusOf(doc.id)).toBe("To check"); // nothing changes before the new run made its draft
  });

  it("refuses a Final, a Superseded or an unknown document", async () => {
    const { doc } = await madeDraft();
    for (const status of ["Final", "Superseded"] as const) {
      await db
        .update(documents)
        .set(status === "Final" ? FINAL : { status, version: null, pdfKey: null })
        .where(eq(documents.id, doc.id));
      await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/only a draft/);
      expect(await canRerun(db, { ...doc, status })).toBe(false);
    }
    await expect(rerunJob(db, storage, willem, "not-an-id")).rejects.toThrow(/not found/);
    await expect(rerunJob(db, storage, willem, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/);
  });

  it("refuses a document that was not made from a supplier document", async () => {
    const [doc] = await db
      .insert(documents)
      .values({ name: "TMC_COA_uploaded", type: "COA", entity: "TMC", status: "To check", createdBy: willem.email })
      .returning();
    expect(await canRerun(db, doc)).toBe(false);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/not made from a supplier document/);
  });

  it("refuses a draft from before the supplier name was required", async () => {
    const { doc, job: first } = await madeDraft();
    await db.update(jobs).set({ supplierName: null }).where(eq(jobs.id, first.id));
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/supplier name/);
  });

  it("refuses a second run while the first still waits or runs (double click)", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/already being run again/);
    // both at once: the database lets one through
    const { doc: other } = await madeDraft({}, "TMC_COA_840.S0959_Other");
    const results = await Promise.allSettled([rerunJob(db, storage, willem, other.id), rerunJob(db, storage, dennis, other.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(JobError);
  });

  it("refuses while the draft is being finalised", async () => {
    const { doc } = await madeDraft();
    await db.insert(jobs).values({ kind: "finalise", documentId: doc.id, createdBy: willem.email, payload: { mode: "editor", metadata: {} } as never });
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/being finalised/);
  });

  it("refuses when the person already has too many open jobs", async () => {
    const { doc } = await madeDraft();
    await db.insert(jobs).values(Array.from({ length: MAX_OPEN_JOBS_PER_USER }, () => ({ kind: "neutralise" as const, createdBy: willem.email })));
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/many documents waiting/);
  });

  it("refuses when a stored file is gone", async () => {
    const { doc, job: first } = await madeDraft();
    files.delete(first.supplierFile!.key);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/not found/);
  });

  it("the new run's draft replaces the old one: Superseded, never overwritten", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const again = (await claimNextJob(db))!;
    expect(again.rerunOf).toBe(doc.id);
    await saveDrafts(db, again, [draft("TMC_COA_840.S0959_Euxyl_PE_9010_LOT2504280")], 0, "engine log");
    expect(await statusOf(doc.id)).toBe("Superseded");
    const newer = (await db.select().from(documents).where(eq(documents.jobId, again.id)))[0];
    expect(newer).toMatchObject({ status: "To check", name: "TMC_COA_840.S0959_Euxyl_PE_9010_LOT2504280" });
    const superseded = (await db.select().from(auditLog)).filter((a) => a.action === "document.superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ documentId: doc.id });
  });

  it("a rejected draft can be run again and is replaced the same way", async () => {
    const { doc } = await madeDraft();
    await db.update(documents).set({ status: "Rejected", rejectedReason: "wrong batch" }).where(eq(documents.id, doc.id));
    await rerunJob(db, storage, willem, doc.id);
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_new")], 0, "log");
    expect(await statusOf(doc.id)).toBe("Superseded");
  });

  it("a failed run leaves the old draft as it was", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    await failJob(db, (await claimNextJob(db))!, 1, "engine failed");
    expect(await statusOf(doc.id)).toBe("To check");
  });

  it("a draft finalised meanwhile is left alone, and the job log says so", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const again = (await claimNextJob(db))!;
    await db.update(documents).set(FINAL).where(eq(documents.id, doc.id));
    await saveDrafts(db, again, [draft("TMC_COA_new")], 0, "engine log");
    expect(await statusOf(doc.id)).toBe("Final");
    const [j] = await db.select().from(jobs).where(eq(jobs.id, again.id));
    expect(j.log).toContain("earlier draft was not replaced");
  });
});

describe("dossier overview", () => {
  it("accepts a file nr as typed and refuses empty, overlong, slashes and control characters", () => {
    expect(dossierFileNr(" 840.S0959 ")).toBe("840.S0959");
    expect(dossierFileNr("PO019192")).toBe("PO019192");
    for (const bad of ["", "   ", "x".repeat(51), "../etc", "a/b", "a\\b", "a\u0000b", "-x", 42, null, undefined]) {
      expect(dossierFileNr(bad)).toBeNull();
    }
  });

  it("lists only that dossier's documents and neutralise jobs, newest first", async () => {
    const { doc: first } = await madeDraft({}, "TMC_COA_840.S0959_A");
    const { doc: second } = await madeDraft({}, "TMC_COA_840.S0959_B");
    await madeDraft({ fileNr: "840.S0001" }, "TMC_COA_840.S0001_C");
    await db.update(documents).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(documents.id, first.id));

    const docs = await getDossierDocuments(db, "840.S0959");
    expect(docs.map((d) => d.id)).toEqual([second.id, first.id]);
    expect(docs[0]).toMatchObject({ status: "To check", yellowParts: [expect.objectContaining({ id: "y0" })] });

    const rows = await listJobs(db, 100, "840.S0959");
    expect(rows).toHaveLength(2);
    expect(rows.every(({ job }) => job.fileNr === "840.S0959" && job.kind === "neutralise")).toBe(true);
    expect(await listJobs(db, 100, "nothing")).toEqual([]);
    expect((await listJobs(db)).length).toBe(3); // without a file nr: every job, as before
  });
});
