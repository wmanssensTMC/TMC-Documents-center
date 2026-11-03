// "Run again with the latest neutralizer" and the dossier overview (Willem 02/11).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiCaller } from "../api/keys";
import { createRequest } from "../api/requests";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { auditLog, documents, jobs } from "../db/schema";
import { approveDraft, rejectDraft, requestFinalise } from "../documents/check";
import { dossierFileNr, dossierHref, getDossierDocuments } from "../documents/dossier";
import { newUploadKey } from "../files";
import { createLabelJob } from "../labels";
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
  it("accepts any file nr a check screen accepts ('/' and '-' too) and refuses empty, overlong and control characters", () => {
    expect(dossierFileNr(" 840.S0959 ")).toBe("840.S0959");
    expect(dossierFileNr("PO019192")).toBe("PO019192");
    expect(dossierFileNr("PO/2026-12")).toBe("PO/2026-12"); // review L1: the link works for it too
    expect(dossierFileNr("-x")).toBe("-x");
    for (const bad of ["", "   ", "x".repeat(51), "a\u0000b", "a\u0085b", 42, null, undefined]) {
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
    expect(docs[0]).toMatchObject({ status: "To check", yellowCount: 1 });

    const rows = await listJobs(db, 100, { fileNr: "840.S0959" });
    expect(rows).toHaveLength(2);
    expect(rows.every(({ job }) => job.fileNr === "840.S0959" && job.kind === "neutralise")).toBe(true);
    expect(await listJobs(db, 100, { fileNr: "nothing" })).toEqual([]);
    expect((await listJobs(db)).length).toBe(3); // without a file nr: every job, as before
  });
});

// --- Testing review 02/11: edges, refusals and abuse cases not covered above ---

const sampleLabel = { template: "sample", language: "EN", entity: "TMC", productName: "Euxyl PE 9010", batch: "LOT2504280", fileNr: "840.S0959" };

/** The same database, but `transaction` first runs `before` (a click or a failure in between). */
function withBeforeTransaction(before: () => Promise<void>): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return async (fn: Parameters<Db["transaction"]>[0]) => {
        await before();
        return db.transaction(fn);
      };
    },
  }) as Db;
}

describe("run again: more refusals", () => {
  it("refuses a label draft: it was not made from a supplier document", async () => {
    await createLabelJob(db, dennis, sampleLabel);
    const run = (await claimNextJob(db))!;
    const label: Draft = { ...draft("TMC_LABEL_840.S0959_Euxyl_PE_9010_LOT2504280_EN"), type: "LABEL", sourceKey: null, sourceFilename: null, by: "label" };
    await saveDrafts(db, run, [label], 0, "ok");
    const [doc] = await db.select().from(documents).where(eq(documents.jobId, run.id));
    expect(await canRerun(db, doc)).toBe(false);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/not made from a supplier document/);
  });

  it("refuses when a stored commercial file (PFI) is gone, and files no job", async () => {
    const { doc, job: first } = await madeDraft();
    files.delete(first.commercialFiles[0].key);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(JobError);
    expect(await db.select().from(jobs).where(eq(jobs.rerunOf, doc.id))).toHaveLength(0);
  });

  it("refuses a blank (spaces only) supplier name on the source job", async () => {
    const { doc, job: first } = await madeDraft();
    await db.update(jobs).set({ supplierName: "   " }).where(eq(jobs.id, first.id));
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/supplier name/);
  });

  it("refuses ids that are not a document id (empty, injection, path, oversized, NUL, unicode digits)", async () => {
    const bad = ["", " ", "'; drop table jobs; --", "../../etc/passwd", "x".repeat(10_000), "0000000-0000-0000-0000-000000000000\u0000", "٠".repeat(8) + "-٠٠٠٠-٠٠٠٠-٠٠٠٠-" + "٠".repeat(12)];
    for (const id of bad) await expect(rerunJob(db, storage, willem, id)).rejects.toThrow(/document not found/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  // KNOWN BUG (testing review 02/11): rerunJob's /^[0-9a-f-]{36}$/ lets "-" x 36 through to the
  // uuid query, which throws a database error (the action shows its generic message and logs it).
  // Checking the id with z.uuid() as lib/api/requests.ts does fixes it; then turn `it.fails` into `it`.
  it("a 36-character id of dashes only is refused as 'not found', not a database error", async () => {
    await expect(rerunJob(db, storage, willem, "-".repeat(36))).rejects.toBeInstanceOf(JobError);
  });
});

describe("run again: open-job cap", () => {
  it("counts the clicking person's open jobs, not those of who made the draft", async () => {
    const { doc } = await madeDraft();
    await db.insert(jobs).values(Array.from({ length: MAX_OPEN_JOBS_PER_USER }, () => ({ kind: "neutralise" as const, createdBy: dennis.email })));
    await expect(rerunJob(db, storage, willem, doc.id)).resolves.toBeTypeOf("string");
  });

  it("allows the run that brings the person exactly to the cap", async () => {
    const { doc } = await madeDraft();
    await db.insert(jobs).values(Array.from({ length: MAX_OPEN_JOBS_PER_USER - 1 }, () => ({ kind: "neutralise" as const, createdBy: willem.email })));
    await expect(rerunJob(db, storage, willem, doc.id)).resolves.toBeTypeOf("string");
  });
});

describe("run again: one open run per draft", () => {
  it("the database refuses a second queued or running run for the same draft", async () => {
    const { doc } = await madeDraft();
    await db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, createdBy: willem.email });
    await expect(db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, createdBy: dennis.email })).rejects.toThrow();
    await expect(db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, state: "running", createdBy: dennis.email })).rejects.toThrow();
  });

  it("the database allows a new run once the earlier ones are finished", async () => {
    const { doc } = await madeDraft();
    for (const state of ["failed", "done", "to_check", "cancelled"] as const) {
      await db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, state, createdBy: willem.email });
    }
    await expect(db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, createdBy: willem.email })).resolves.toBeDefined();
  });

  it("the other click winning between the check and the insert gives a clear refusal, not an error page", async () => {
    const { doc } = await madeDraft();
    const racing = withBeforeTransaction(async () => {
      await db.insert(jobs).values({ kind: "neutralise", rerunOf: doc.id, createdBy: dennis.email });
    });
    const err = await rerunJob(racing, storage, willem, doc.id).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(err.message).toMatch(/already being run again/);
    expect(await db.select().from(jobs).where(eq(jobs.rerunOf, doc.id))).toHaveLength(1);
    expect((await db.select().from(auditLog)).filter((a) => a.action === "document.rerun")).toHaveLength(0);
  });

  it("a database failure while filing is passed on as it is, and nothing is filed", async () => {
    const { doc } = await madeDraft();
    const broken = withBeforeTransaction(async () => {
      throw new Error("connection terminated");
    });
    const err = await rerunJob(broken, storage, willem, doc.id).catch((e) => e);
    expect(err).not.toBeInstanceOf(JobError);
    expect(err.message).toBe("connection terminated");
    expect(await db.select().from(jobs).where(eq(jobs.rerunOf, doc.id))).toHaveLength(0);
  });

  it("a failed run can be followed by a new run of the same draft", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    await failJob(db, (await claimNextJob(db))!, 1, "engine failed");
    await expect(rerunJob(db, storage, willem, doc.id)).resolves.toBeTypeOf("string");
    expect(await db.select().from(jobs).where(eq(jobs.rerunOf, doc.id))).toHaveLength(2);
  });

  it("a running finalise job blocks a run again; a finished one does not", async () => {
    const { doc } = await madeDraft();
    const [fin] = await db
      .insert(jobs)
      .values({ kind: "finalise", state: "running", documentId: doc.id, createdBy: willem.email, payload: { mode: "approve", metadata: {} } as never })
      .returning();
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/being finalised/);
    await db.update(jobs).set({ state: "failed" }).where(eq(jobs.id, fin.id));
    await expect(rerunJob(db, storage, willem, doc.id)).resolves.toBeTypeOf("string");
  });
});

describe("run again: the worker replaces the old draft", () => {
  it("the audit says who ran it again, from which job and file; the replacement is on the rerunner's name", async () => {
    const { doc, job: first } = await madeDraft();
    const id = await rerunJob(db, storage, willem, doc.id);
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_new")], 0, "log");
    const audit = await db.select().from(auditLog);
    expect(audit.find((a) => a.action === "document.rerun")).toMatchObject({
      actor: willem.email,
      documentId: doc.id,
      details: { job: id, from: first.id, file: "supplier coa.pdf" },
    });
    expect(audit.find((a) => a.action === "document.superseded")).toMatchObject({ actor: willem.email, documentId: doc.id, details: { job: id, by: "run again" } });
  });

  it("a run that made no draft leaves the old draft as it was, with no replacement in the audit", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    await saveDrafts(db, (await claimNextJob(db))!, [], 0, "engine made nothing");
    expect(await statusOf(doc.id)).toBe("To check");
    expect((await db.select().from(auditLog)).filter((a) => a.action === "document.superseded")).toHaveLength(0);
  });

  it("several drafts from one run (one per batch) replace the old draft once", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_new_A"), draft("TMC_COA_new_B")], 0, "log");
    expect(await statusOf(doc.id)).toBe("Superseded");
    expect((await db.select().from(auditLog)).filter((a) => a.action === "document.superseded")).toHaveLength(1);
  });

  it("the new draft is To check, never Final, even when the engine left nothing yellow", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const again = (await claimNextJob(db))!;
    const clean: Draft = { ...draft("TMC_COA_clean"), yellow: false, yellowParts: [], pdfKey: newUploadKey("pdf"), pdfFilename: "TMC_COA_clean.pdf" };
    await saveDrafts(db, again, [clean], 0, "log");
    const [newer] = await db.select().from(documents).where(eq(documents.jobId, again.id));
    expect(newer).toMatchObject({ status: "To check", version: null });
  });

  it("a draft already replaced meanwhile stays Superseded and gets no second replacement row", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const again = (await claimNextJob(db))!;
    await db.update(documents).set({ status: "Superseded" }).where(eq(documents.id, doc.id));
    await saveDrafts(db, again, [draft("TMC_COA_new")], 0, "engine log");
    expect(await statusOf(doc.id)).toBe("Superseded");
    expect((await db.select().from(auditLog)).filter((a) => a.action === "document.superseded")).toHaveLength(0);
    expect((await db.select().from(jobs).where(eq(jobs.id, again.id)))[0].log).toMatch(/^engine log\n\[worker\] the earlier draft was not replaced/);
  });

  it("the new draft can itself be run again; the first one stays Superseded", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const second = (await claimNextJob(db))!;
    await saveDrafts(db, second, [draft("TMC_COA_second")], 0, "log");
    const [newer] = await db.select().from(documents).where(eq(documents.jobId, second.id));
    await expect(rerunJob(db, storage, dennis, doc.id)).rejects.toThrow(/only a draft/);
    await expect(rerunJob(db, storage, dennis, newer.id)).resolves.toBeTypeOf("string");
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_third")], 0, "log");
    expect(await statusOf(newer.id)).toBe("Superseded");
    expect(await statusOf(doc.id)).toBe("Superseded");
  });
});

describe("dossier overview: more", () => {
  it("file nr: accepts exactly 50 characters and unicode; refuses tab, CR/LF, DEL, C1 controls, non-strings", () => {
    expect(dossierFileNr("x".repeat(50))).toBe("x".repeat(50));
    expect(dossierFileNr("840.S0959-é")).toBe("840.S0959-é");
    const bad: unknown[] = ["a\tb", "a\nb", "a\rb", "a\u007fb", "a\u0080b", "a\u009fb", {}, ["840.S0959"]];
    for (const v of bad) expect(dossierFileNr(v)).toBeNull();
  });

  it("the link carries the file nr in ?nr=, decoded exactly once: '50%25', '/' and spaces round-trip (review L1, L2)", () => {
    for (const nr of ["50%25", "PO/2026", "840.S0959 A", "a&b=c", "../etc"]) {
      const href = dossierHref(nr);
      expect(href.startsWith("/dossiers?nr=")).toBe(true);
      const back = new URL(href, "https://dc.example.com").searchParams.get("nr");
      expect(dossierFileNr(back)).toBe(nr);
    }
  });

  it("matches the file nr exactly: no prefix, no other case, no LIKE wildcards, no injection", async () => {
    await madeDraft({}, "TMC_COA_840.S0959_A");
    for (const probe of ["840.S095", "840.s0959", "840.%", "840.S095_", "840.S0959' OR '1'='1", "%"]) {
      expect(await getDossierDocuments(db, probe)).toEqual([]);
      expect(await listJobs(db, 100, { fileNr: probe })).toEqual([]);
    }
    expect(await db.select().from(documents)).toHaveLength(1);
  });

  it("lists only neutralise jobs: a label of the same dossier is left out of the jobs list", async () => {
    await madeDraft();
    await createLabelJob(db, dennis, sampleLabel);
    const rows = await listJobs(db, 100, { fileNr: "840.S0959" });
    expect(rows.map(({ job }) => job.kind)).toEqual(["neutralise"]);
  });

  it("caps the jobs at the limit given, newest first", async () => {
    for (let i = 0; i < 3; i++) await createJobs(db, storage, dennis, [job()]);
    await db.update(jobs).set({ createdAt: new Date(Date.now() - 60_000) });
    const [newest] = await createJobs(db, storage, dennis, [job()]);
    const rows = await listJobs(db, 2, { fileNr: "840.S0959" });
    expect(rows).toHaveLength(2);
    expect(rows[0].job.id).toBe(newest);
  });

  it("caps the documents at 200", async () => {
    await db.insert(documents).values(
      Array.from({ length: 201 }, (_, i) => ({ name: `TMC_COA_840.S0959_${i}`, type: "COA" as const, entity: "TMC" as const, fileNr: "840.S0959", status: "To check" as const, createdBy: willem.email })),
    );
    expect(await getDossierDocuments(db, "840.S0959")).toHaveLength(200);
  });

  it("never returns the supplier name of a document (hard rule 3)", async () => {
    await madeDraft();
    const [d] = await getDossierDocuments(db, "840.S0959");
    expect(d).not.toHaveProperty("supplierName");
    expect(JSON.stringify(d)).not.toContain("Example Supplier BV");
  });
});

describe("listJobs filter object", () => {
  const caller: ApiCaller = { client: "tmclog", keyId: randomUUID(), allowedKinds: ["coa-neutralise"] };
  async function request() {
    const requestId = randomUUID();
    const b = {
      kind: "coa-neutralise",
      entity: "TMC",
      source: { app: "tmc-logistics", requestId, orderNo: "840.S0959", partNo: 1, requestedBy: "stivdb@transmare.com", reason: "neutral-customer" },
      facts: { lines: [{ lineNo: 10000, itemNo: "IT-1", description: "Euxyl PE 9010" }] },
    };
    return (await createRequest(db, caller, requestId, b)).job.jobId;
  }

  it("{ apiJobId } still lists only the runs of that API request (API v1 request page)", async () => {
    process.env.APP_URL = "https://dc.example.com";
    const a = await request();
    const b = await request();
    const [runA] = await createJobs(db, storage, dennis, [job({ apiJobId: a })]);
    await createJobs(db, storage, dennis, [job({ apiJobId: b }), job()]);
    expect((await listJobs(db, 100, { apiJobId: a })).map(({ job }) => job.id)).toEqual([runA]);
    expect(await listJobs(db, 100, { apiJobId: randomUUID() })).toEqual([]);
    expect(await listJobs(db)).toHaveLength(3);
  });
});

describe("security review of Run again (88/100): fixes", () => {
  const caller: ApiCaller = { client: "tmclog", keyId: randomUUID(), allowedKinds: ["coa-neutralise"] };
  async function apiRequest() {
    process.env.APP_URL = "https://dc.example.com";
    const requestId = randomUUID();
    const b = {
      kind: "coa-neutralise",
      entity: "TMC",
      source: { app: "tmc-logistics", requestId, orderNo: "840.S0959", partNo: 1, requestedBy: "stivdb@transmare.com", reason: "neutral-customer" },
      facts: { lines: [{ lineNo: 10000, itemNo: "IT-1", description: "Euxyl PE 9010" }] },
    };
    return (await createRequest(db, caller, requestId, b)).job.jobId;
  }

  it("H1: a draft that answers a request from TMC Logistics is never run again here", async () => {
    const { doc } = await madeDraft({ apiJobId: await apiRequest() });
    expect(await canRerun(db, doc)).toBe(false);
    await expect(rerunJob(db, storage, willem, doc.id)).rejects.toThrow(/request from TMC Logistics/);
    expect(await db.select().from(jobs).where(eq(jobs.rerunOf, doc.id))).toHaveLength(0);
  });

  it("M1: finalise, approve and reject wait while the draft is being run again", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const metadata = { productName: "Euxyl PE 9010", fileNr: "840.S0959", batch: "LOT2504280" };
    await expect(requestFinalise(db, storage, willem, doc.id, { mode: "editor", metadata, fixes: {} })).rejects.toThrow(/being run again/);
    await expect(approveDraft(db, willem, doc.id, metadata)).rejects.toThrow(/being run again/);
    await expect(rejectDraft(db, willem, doc.id, "not good")).rejects.toThrow(/being run again/);
    expect(await statusOf(doc.id)).toBe("To check");
  });

  it("M2: one run per supplier document replaces every waiting draft of it, audited one by one", async () => {
    await createJobs(db, storage, dennis, [job()]);
    const first = (await claimNextJob(db))!;
    await saveDrafts(db, first, [draft("TMC_COA_A"), draft("TMC_COA_B"), draft("TMC_COA_C")], 2, "log");
    const [a, b, c] = await db.select().from(documents).where(eq(documents.jobId, first.id)).orderBy(documents.name);
    await db.update(documents).set(FINAL).where(eq(documents.id, c.id)); // one already Final: never touched
    await db.update(documents).set({ status: "Rejected", rejectedReason: "no" }).where(eq(documents.id, b.id));
    await rerunJob(db, storage, willem, a.id);
    // a second click on another draft of the same supplier document: refused, one run only
    await expect(rerunJob(db, storage, willem, b.id)).rejects.toThrow(/already being run again/);
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_A2"), draft("TMC_COA_B2")], 2, "log");
    expect(await statusOf(a.id)).toBe("Superseded");
    expect(await statusOf(b.id)).toBe("Superseded");
    expect(await statusOf(c.id)).toBe("Final");
    const superseded = (await db.select().from(auditLog)).filter((x) => x.action === "document.superseded").map((x) => x.documentId);
    expect(superseded.sort()).toEqual([a.id, b.id].sort());
    // the earlier run is done now that none of its drafts waits
    expect((await db.select().from(jobs).where(eq(jobs.id, first.id)))[0].state).toBe("done");
  });

  it("M1: a sibling being finalised is left as it is when the run's drafts arrive", async () => {
    await createJobs(db, storage, dennis, [job()]);
    const first = (await claimNextJob(db))!;
    await saveDrafts(db, first, [draft("TMC_COA_A"), draft("TMC_COA_B")], 2, "log");
    const [a, b] = await db.select().from(documents).where(eq(documents.jobId, first.id)).orderBy(documents.name);
    await rerunJob(db, storage, willem, a.id);
    const rerun = (await claimNextJob(db))!;
    await db.insert(jobs).values({ kind: "finalise", documentId: b.id, state: "queued", createdBy: willem.email });
    await saveDrafts(db, rerun, [draft("TMC_COA_A2")], 2, "log");
    expect(await statusOf(a.id)).toBe("Superseded");
    expect(await statusOf(b.id)).toBe("To check");
  });

  it("L6: a replaced draft keeps no DRAFT preview or editor view", async () => {
    const { doc } = await madeDraft();
    await db.update(documents).set({ previewKey: newUploadKey("preview"), viewKey: newUploadKey("view") }).where(eq(documents.id, doc.id));
    await rerunJob(db, storage, willem, doc.id);
    await saveDrafts(db, (await claimNextJob(db))!, [draft("TMC_COA_new")], 2, "log");
    const [old] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(old).toMatchObject({ status: "Superseded", previewKey: null, viewKey: null });
  });

  it("L3: a draft finalised meanwhile gets an audit row saying it was not replaced", async () => {
    const { doc } = await madeDraft();
    await rerunJob(db, storage, willem, doc.id);
    const rerun = (await claimNextJob(db))!;
    await db.update(documents).set(FINAL).where(eq(documents.id, doc.id));
    await saveDrafts(db, rerun, [draft("TMC_COA_new")], 2, "log");
    const rows = (await db.select().from(auditLog)).filter((x) => x.action === "document.rerun_not_applied");
    expect(rows.map((x) => x.documentId)).toEqual([doc.id]);
  });
});
