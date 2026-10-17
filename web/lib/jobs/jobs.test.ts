import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { auditLog, jobs } from "../db/schema";
import { getEntity, saveEntity, EntityError } from "../entities";
import { newUploadKey } from "../files";
import type { Storage } from "../storage";
import { sql } from "drizzle-orm";
import { createJobs, JobError, listJobs, MAX_OPEN_JOBS_PER_USER, type JobInput } from "./index";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const admin: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
const user: Actor = { email: "dennis@transmare.com", name: "Dennis", role: "user" };

let db: Db;
let files: Map<string, Uint8Array>;
const storage: Storage = {
  mode: "local",
  put: async () => {},
  get: async () => null,
  head: async (key) => (files.has(key) ? { bytes: files.get(key)!, size: files.get(key)!.length } : null),
};

function input(name = "supplier-coa.pdf", bytes = PDF) {
  const key = newUploadKey("input");
  files.set(key, bytes);
  return { key, filename: name };
}

function job(over: Partial<JobInput> = {}): JobInput {
  return { route: "coa", entity: "TMC", fileNr: "840.S0850", supplierFile: input(), ...over };
}

beforeEach(async () => {
  db = await createPgliteDb();
  files = new Map();
});

describe("entities", () => {
  it("TMC NV is pre-filled from the engine's entity.example.json, the others are empty", async () => {
    expect(await getEntity(db, "TMC")).toMatchObject({ naam: "Transmare Chemie NV", nood: "+32 (0)14 58 45 45" });
    expect(await getEntity(db, "TMCGULF")).toBeNull();
    expect(await getEntity(db, "PHARMALABO")).toBeNull();
  });

  it("an admin saves a complete record; incomplete or unknown is refused", async () => {
    const rec = { naam: "X", adres: "A", telefoon: "1", email: "e@x", web: "w", btw: "b", nood: "n" };
    await expect(saveEntity(db, admin, "TMCGULF", { ...rec, adres: " " })).rejects.toThrow(EntityError);
    await expect(saveEntity(db, admin, "ACME", rec)).rejects.toThrow(EntityError);
    await saveEntity(db, admin, "TMCGULF", rec);
    expect(await getEntity(db, "TMCGULF")).toMatchObject({ naam: "X", updatedBy: admin.email });
    await saveEntity(db, admin, "TMCGULF", { ...rec, nood: "112" });
    const last = (await db.select().from(auditLog)).filter((a) => a.action === "entity.saved").pop();
    expect(last?.details).toEqual({ entity: "TMCGULF", changes: { nood: { before: "n", after: "112" } } });
  });
});

describe("createJobs", () => {
  it("queues one job per supplier document with the typed values", async () => {
    const ids = await createJobs(db, storage, user, [job(), job({ batch: "L2", productName: "Betaine" })]);
    expect(ids).toHaveLength(2);
    const rows = await db.select().from(jobs);
    expect(rows.every((r) => r.state === "queued" && r.kind === "neutralise" && r.createdBy === user.email)).toBe(true);
    expect(rows.find((r) => r.batch === "L2")).toMatchObject({ productName: "Betaine", fileNr: "840.S0850" });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "job.created")).toHaveLength(2);
    expect((await listJobs(db))[0].documents).toEqual([]);
  });

  it("refuses a job for an entity without details (never invent an address)", async () => {
    await expect(createJobs(db, storage, user, [job({ entity: "PHARMALABO" })])).rejects.toThrow(/no details/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("is all-or-nothing: one bad file refuses the whole batch", async () => {
    await expect(createJobs(db, storage, user, [job(), job({ supplierFile: input("x.pdf", DOCX) })])).rejects.toThrow(
      /not a PDF/,
    );
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("refuses foreign or traversal storage keys", async () => {
    for (const key of ["../../etc/passwd", newUploadKey("pdf"), "uploads/x/input"]) {
      await expect(createJobs(db, storage, user, [job({ supplierFile: { key, filename: "a.pdf" } })])).rejects.toThrow(
        JobError,
      );
    }
  });

  it("commercial documents only go with a COA", async () => {
    await expect(
      createJobs(db, storage, user, [job({ route: "sds", commercialFiles: [input("pfi.pdf")] })]),
    ).rejects.toThrow(/only go with a COA/);
    await createJobs(db, storage, user, [job({ commercialFiles: [input("pfi.pdf")] })]);
  });

  it("caps open jobs per person", async () => {
    for (let i = 0; i < MAX_OPEN_JOBS_PER_USER / 20; i++) {
      await createJobs(db, storage, user, Array.from({ length: 20 }, () => job()));
    }
    await expect(createJobs(db, storage, user, [job()])).rejects.toThrow(/many documents waiting/);
    await createJobs(db, storage, admin, [job()]); // other people are not blocked
  });

  it("the database refuses a Final document without PDF or version", async () => {
    const reason = (q: Promise<unknown>) =>
      q.then(
        () => "allowed",
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(
      await reason(
        db.execute(sql`insert into documents (name, type, product_name, status, created_by) values ('X', 'COA', 'x', 'Final', 'x')`),
      ),
    ).toMatch(/documents_final_complete/);
    expect(
      await reason(
        db.execute(sql`insert into documents (name, type, product_name, status, created_by) values ('X', 'COA', 'x', 'To check', 'x')`),
      ),
    ).toBe("allowed");
  });

  it("validates sizes and counts", async () => {
    await expect(createJobs(db, storage, user, [])).rejects.toThrow(JobError);
    await expect(createJobs(db, storage, user, Array.from({ length: 21 }, () => job()))).rejects.toThrow(/20/);
    await expect(createJobs(db, storage, user, [job({ batch: "x".repeat(101) })])).rejects.toThrow(JobError);
    await expect(createJobs(db, storage, user, [job({ route: "label" as "coa" })])).rejects.toThrow(JobError);
  });
});
