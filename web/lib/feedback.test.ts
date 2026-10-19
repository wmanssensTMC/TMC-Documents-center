import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb, type Db } from "./db";
import { documents, feedback, jobs } from "./db/schema";
import { newUploadKey } from "./files";
import { failedJobs, feedbackLines, feedbackSummary, periodFromDays, toCsv, topCorrections } from "./feedback";

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  const [job] = await db
    .insert(jobs)
    .values({ kind: "neutralise", state: "to_check", createdBy: "a@x", supplierFile: { key: newUploadKey("input"), filename: "s.pdf" } })
    .returning();
  await db.insert(jobs).values({ kind: "neutralise", state: "failed", createdBy: "a@x", log: "not recognised", supplierFile: { key: newUploadKey("input"), filename: "letter.pdf" } });
  const [d] = await db
    .insert(documents)
    .values({ name: "TMC_COA_x", type: "COA", status: "To check", createdBy: "a@x", jobId: job.id, docxKey: newUploadKey("docx") })
    .returning();
  await db.insert(feedback).values([
    { actor: "kars@x", documentId: d.id, kind: "corrected", partId: "y0", before: "PRODUCTNAME", after: "Betaine" },
    { actor: "kars@x", documentId: d.id, kind: "corrected", partId: "y1", before: "productname ", after: "Glycerin" },
    { actor: "kars@x", documentId: d.id, kind: "corrected", partId: "y2", before: "01/09/2O29", after: "01/09/2029" },
    { actor: "kars@x", documentId: d.id, kind: "confirmed", partId: "y3", before: "OK", after: "OK" },
    { actor: "kars@x", documentId: d.id, kind: "rejected", reason: "Assay missing" },
  ]);
});

describe("feedback overview", () => {
  it("summarises the period", async () => {
    const s = await feedbackSummary(db, periodFromDays(30));
    expect(s).toMatchObject({ drafts: 1, finalViaEngine: 0, rejected: 1, failedJobs: 1, corrected: 3, confirmed: 1, correctedShare: 75 });
  });

  it("groups the same misreading, whatever the case or spaces", async () => {
    const top = await topCorrections(db, periodFromDays(30));
    expect(top[0]).toMatchObject({ times: 2, types: "COA" });
    expect(top[0].before.toLowerCase().trim()).toBe("productname");
  });

  it("lists corrections and rejections with their document, and failed jobs", async () => {
    const lines = await feedbackLines(db, periodFromDays(30), ["corrected", "rejected"]);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.name === "TMC_COA_x")).toBe(true);
    expect((await failedJobs(db, periodFromDays(30)))[0].file?.filename).toBe("letter.pdf");
  });

  it("CSV export cannot inject formulas into Excel", () => {
    const csv = toCsv([{ a: "=HYPERLINK(\"x\")", b: "+1", c: 'say "hi"' }], ["a", "b", "c"]);
    expect(csv).toBe('a;b;c\r\n"\'=HYPERLINK(""x"")";"\'+1";"say ""hi"""');
  });
});
