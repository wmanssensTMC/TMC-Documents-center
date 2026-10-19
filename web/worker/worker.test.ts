import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../lib/audit";
import { createPgliteDb, type Db } from "../lib/db";
import { documents, feedback, jobs } from "../lib/db/schema";
import { newUploadKey } from "../lib/files";
import { createJobs } from "../lib/jobs";
import { claimNextJob, MAX_ATTEMPTS, requeueStaleJobs } from "../lib/jobs/worker-state";
import { localStorage, type Storage } from "../lib/storage";
import { cleanLog, engineArgv } from "./engine";
import { changeWarnings } from "../lib/documents/changes";
import { approveDraft, requestFinalise } from "../lib/documents/check";
import { plainName, processFinaliseJob, processNeutraliseJob, safeName } from "./process";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const willem: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };

let db: Db;
let storage: Storage;

async function upload(bytes: Uint8Array, filename = "coa.pdf") {
  const key = newUploadKey("input");
  await storage.put(key, bytes, "application/pdf");
  return { key, filename };
}

beforeEach(async () => {
  db = await createPgliteDb();
  storage = localStorage(mkdtempSync(path.join(os.tmpdir(), "tmc-store-")));
});

describe("engine call safety (review N2/N3)", () => {
  it("passes typed values as one --option=value argument, so they can never become options", () => {
    const argv = engineArgv({
      inputs: ["/job/in/00_coa.pdf"],
      outDir: "/job/out",
      entityJson: "/job/entity.json",
      workDir: "/job",
      route: "coa",
      productName: "--finalise",
      fileNr: "840.S0850; rm -rf /",
      batch: "-x",
    });
    expect(argv).toContain("--product-name=--finalise");
    expect(argv).toContain("--file-nr=840.S0850; rm -rf /");
    expect(argv).toContain("--batch=-x");
    expect(argv).toContain("--type=coa");
    expect(argv).not.toContain("--finalise");
  });

  it("makes safe local file names from user file names", () => {
    expect(safeName("../../etc/passwd", 0)).toBe("00_etc_passwd.pdf");
    expect(safeName("-rf supplier COA.pdf", 1)).toBe("01_rf_supplier_COA.pdf");
    expect(safeName("..", 2)).toBe("02_document.pdf");
    expect(safeName("Crème brûlée.pdf", 3)).toBe("03_Cr_me_br_l_e.pdf");
  });

  it("accepts every name the engine can make, refuses path tricks (review L4/N3)", () => {
    for (const ok of ["TMC_TDS_Glycerin_(USP)_99,5%", "TMC_MSDS_A&B+C_Crème", "TMC_COA_840.S0850_Betaine_AI_test_BT-3877"]) {
      expect(plainName(ok), ok).toBe(true);
    }
    for (const bad of ["TMC_TDS_a/b", "TMC_TDS_a\b", "TMC_TDS_..", "TMC_TDS_x..y", "../TMC_TDS_x", "OTHER_TDS_x", "TMC_TDS_"]) {
      expect(plainName(bad), bad).toBe(false);
    }
  });

  it("cleans paths out of the log and caps its length", () => {
    expect(cleanLog("error in /tmp/tmc-job-123/in/a.pdf", "/tmp/tmc-job-123")).toBe("error in <job>/in/a.pdf");
    expect(cleanLog("x".repeat(20000), "/w").length).toBeLessThanOrEqual(8001);
  });
});

describe("job queue", () => {
  it("each job is claimed once, oldest first", async () => {
    await createJobs(db, storage, willem, [
      { route: "coa", entity: "TMC", supplierFile: await upload(PDF, "a.pdf") },
      { route: "coa", entity: "TMC", supplierFile: await upload(PDF, "b.pdf") },
    ]);
    const first = await claimNextJob(db);
    const second = await claimNextJob(db);
    expect([first?.supplierFile?.filename, second?.supplierFile?.filename]).toEqual(["a.pdf", "b.pdf"]);
    expect(first?.state).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(await claimNextJob(db)).toBeNull();
  });

  it("a crashed run goes back in the queue, and fails after the last attempt", async () => {
    await createJobs(db, storage, willem, [{ route: "coa", entity: "TMC", supplierFile: await upload(PDF) }]);
    const job = (await claimNextJob(db))!;
    await db.update(jobs).set({ startedAt: sql`now() - interval '2 hours'` }).where(eq(jobs.id, job.id));
    await requeueStaleJobs(db);
    expect((await db.select().from(jobs))[0].state).toBe("queued");

    await db.update(jobs).set({ state: "running", attempts: MAX_ATTEMPTS, startedAt: sql`now() - interval '2 hours'` });
    await requeueStaleJobs(db);
    expect((await db.select().from(jobs))[0].state).toBe("failed");
  });
});

// Runs the real engine. Needs Python with the engine requirements, LibreOffice and poppler:
// set ENGINE_PYTHON (GitHub checks do; a laptop without Python skips it).
const python = process.env.ENGINE_PYTHON;
describe.skipIf(!python)("neutralise with the real engine", () => {
  function syntheticCoa(file: string, dates = true) {
    // Same layout as engine/tests/test_v060_routes.py
    const script = `
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
import sys
c = canvas.Canvas(sys.argv[1], pagesize=A4); W, H = A4
c.setFont("Helvetica", 9); c.drawString(40, H - 40, "ACME Chemicals GmbH, Tel +49 30 1234567")
c.setFont("Helvetica-Bold", 16); c.drawString(40, H - 80, "CERTIFICATE OF ANALYSIS")
c.setFont("Helvetica", 10); y = H - 110
for t in ["Product: Sodium Benzoate", "Batch No: SB-2026-114"] + (["Manufacturing Date: 02/09/2026", "Expiry Date: 01/09/2029"] if sys.argv[2] == "1" else []):
    c.drawString(40, y, t); y -= 14
y -= 10
for row in [("Test", "Specification", "Result", "Unit"), ("Appearance", "White powder", "Complies", "-"),
            ("Assay", "99.0 - 100.5", "99.6", "%"), ("Loss on drying", "NMT 1.5", "0.4", "%")]:
    for x, v in zip((40, 180, 330, 430), row):
        c.drawString(x, y, v)
    y -= 14
c.save()`;
    execFileSync(python!, ["-c", script, file, dates ? "1" : "0"]);
  }

  it("turns a supplier COA into a TMC draft waiting for a person", async () => {
    const pdfPath = path.join(mkdtempSync(path.join(os.tmpdir(), "tmc-coa-")), "supplier coa.pdf");
    syntheticCoa(pdfPath);
    await createJobs(db, storage, willem, [
      {
        route: "coa",
        entity: "TMC",
        productName: "Sodium Benzoate",
        fileNr: "840.S0999",
        supplierName: "ACME Chemicals GmbH",
        supplierFile: await upload(new Uint8Array(readFileSync(pdfPath)), "supplier coa.pdf"),
      },
    ]);
    const job = (await claimNextJob(db))!;
    await processNeutraliseJob(db, storage, job);

    const [done] = await db.select().from(jobs);
    expect(done.state, done.log ?? "").toBe("to_check");
    const docs = await db.select().from(documents);
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(d.name).toMatch(/^TMC_COA_840\.S0999_Sodium_Benzoate/);
    expect(d).toMatchObject({ type: "COA", status: "To check", version: null, jobId: job.id, productName: "Sodium Benzoate" });
    expect(d.docxKey).toBeTruthy();
    expect(d.sourceKey).toBeTruthy();
    // Engine output is never Final by itself (Willem 17/10).
    expect(docs.some((x) => x.status === "Final")).toBe(false);
  }, 180_000);

  it("yellow draft: parts listed, DRAFT preview, a person confirms, the worker finalises to Final", async () => {
    const pdfPath = path.join(mkdtempSync(path.join(os.tmpdir(), "tmc-coa-")), "coa-no-dates.pdf");
    syntheticCoa(pdfPath, false); // no dates on the source: the engine marks them yellow
    await createJobs(db, storage, willem, [
      {
        route: "coa",
        entity: "TMC",
        productName: "Sodium Benzoate",
        fileNr: "840.S0998",
        supplierFile: await upload(new Uint8Array(readFileSync(pdfPath)), "coa-no-dates.pdf"),
      },
    ]);
    await processNeutraliseJob(db, storage, (await claimNextJob(db))!);
    const [job] = await db.select().from(jobs);
    expect(job.state, job.log ?? "").toBe("to_check");
    const [draft] = await db.select().from(documents);
    expect(draft.pdfKey).toBeNull(); // yellow: no PDF until checked
    expect(draft.yellowParts?.length, JSON.stringify(draft.yellowParts)).toBeGreaterThan(0);
    expect(draft.previewKey).toBeTruthy();

    const fixes = Object.fromEntries(draft.yellowParts!.map((p) => [p.id, { value: p.text, confirmed: true }]));
    await requestFinalise(db, storage, willem, draft.id, {
      mode: "editor",
      metadata: { productName: "Sodium Benzoate", fileNr: "840.S0998", batch: "SB-2026-114" },
      fixes,
    });
    const finaliseJob = (await claimNextJob(db))!;
    expect(finaliseJob.kind).toBe("finalise");
    await processFinaliseJob(db, storage, finaliseJob);

    const [fj] = await db.select().from(jobs).where(eq(jobs.id, finaliseJob.id));
    expect(fj.state, fj.log ?? "").toBe("done");
    const [final] = await db.select().from(documents);
    expect(final).toMatchObject({ status: "Final", version: 1, approvedBy: willem.email, batch: "SB-2026-114" });
    expect(final.pdfKey).toBeTruthy();
    const head = await storage.head(final.pdfKey!, 5);
    expect(Buffer.from(head!.bytes).toString()).toBe("%PDF-");
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].state).toBe("done");
  }, 300_000);

  it("approve: details not printed in the document are refused; matching details make it Final (Willem 19/10)", async () => {
    const pdfPath = path.join(mkdtempSync(path.join(os.tmpdir(), "tmc-coa-")), "coa.pdf");
    syntheticCoa(pdfPath);
    await createJobs(db, storage, willem, [
      {
        route: "coa",
        entity: "TMC",
        productName: "Sodium Benzoate",
        fileNr: "840.S0997",
        supplierFile: await upload(new Uint8Array(readFileSync(pdfPath)), "coa.pdf"),
      },
    ]);
    await processNeutraliseJob(db, storage, (await claimNextJob(db))!);
    const [draft] = await db.select().from(documents);
    expect(draft.yellowParts, JSON.stringify(draft.yellowParts)).toEqual([]);
    expect(draft.batch).toBe("SB-2026-114"); // the batch the engine made it for

    // A product name the document does not print: the worker refuses, the draft keeps waiting.
    await approveDraft(db, willem, draft.id, { productName: "Benzoate Pure", fileNr: "840.S0997", batch: "SB-2026-114" });
    const wrong = (await claimNextJob(db))!;
    await processFinaliseJob(db, storage, wrong);
    const [refused] = await db.select().from(jobs).where(eq(jobs.id, wrong.id));
    expect(refused.state).toBe("failed");
    expect(refused.log).toMatch(/product name 'Benzoate Pure' is not printed/);
    expect((await db.select().from(documents))[0].status).toBe("To check");

    await approveDraft(db, willem, draft.id, { productName: "Sodium Benzoate", fileNr: "840.S0997", batch: "SB-2026-114" });
    const ok = (await claimNextJob(db))!;
    await processFinaliseJob(db, storage, ok);
    const [fj] = await db.select().from(jobs).where(eq(jobs.id, ok.id));
    expect(fj.state, fj.log ?? "").toBe("done");
    const [final] = await db.select().from(documents);
    expect(final).toMatchObject({
      status: "Final",
      version: 1,
      name: "TMC_COA_840.S0997_Sodium_Benzoate_SB-2026-114",
      pdfFilename: "TMC_COA_840.S0997_Sodium_Benzoate_SB-2026-114.pdf",
      pdfKey: draft.pdfKey, // the engine's own PDF, only the name follows the rule
    });
  }, 300_000);

  it("edited on screen: a new number not in the original is a warning; once confirmed it is Final and kept as feedback", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tmc-edit-"));
    const pdfPath = path.join(dir, "coa.pdf");
    syntheticCoa(pdfPath);
    await createJobs(db, storage, willem, [
      { route: "coa", entity: "TMC", productName: "Sodium Benzoate", fileNr: "840.S0996", supplierFile: await upload(new Uint8Array(readFileSync(pdfPath)), "coa.pdf") },
    ]);
    await processNeutraliseJob(db, storage, (await claimNextJob(db))!);
    const [draft] = await db.select().from(documents);

    // the person changes the assay 99.6 into 99.9 in the editor
    const file = await storage.get(draft.docxKey!);
    const chunks: Uint8Array[] = [];
    for await (const c of file!.stream as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
    const before = path.join(dir, "draft.docx");
    const after = path.join(dir, "edited.docx");
    writeFileSync(before, Buffer.concat(chunks));
    execFileSync(python!, ["-c", [
      "import sys", "from docx import Document", "d = Document(sys.argv[1])",
      "cells = [c for t in d.tables for r in t.rows for c in r.cells]",
      "runs = [r for p in d.paragraphs for r in p.runs] + [r for c in cells for p in c.paragraphs for r in p.runs]",
      "[setattr(r, 'text', r.text.replace('99.6', '99.9')) for r in runs]", "d.save(sys.argv[2])",
    ].join("; "), before, after]);
    const key = newUploadKey("docx");
    await storage.put(key, new Uint8Array(readFileSync(after)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const metadata = { productName: "Sodium Benzoate", fileNr: "840.S0996", batch: "SB-2026-114" };

    await requestFinalise(db, storage, willem, draft.id, { mode: "edited", metadata, docx: { key, filename: "e.docx" } });
    const first = (await claimNextJob(db))!;
    await processFinaliseJob(db, storage, first);
    const [stopped] = await db.select().from(jobs).where(eq(jobs.id, first.id));
    expect(stopped.state, stopped.log ?? "").toBe("failed");
    expect(changeWarnings(stopped.log)?.[0]?.unknown).toContain("99.9");
    expect((await db.select().from(documents))[0].status).toBe("To check");

    await requestFinalise(db, storage, willem, draft.id, { mode: "edited", metadata, acceptChanges: true, docx: { key, filename: "e.docx" } });
    const second = (await claimNextJob(db))!;
    await processFinaliseJob(db, storage, second);
    const [done] = await db.select().from(jobs).where(eq(jobs.id, second.id));
    expect(done.state, done.log ?? "").toBe("done");
    expect((await db.select().from(documents))[0]).toMatchObject({ status: "Final", docxKey: key });
    const fb = await db.select().from(feedback);
    expect(fb.some((f) => f.kind === "edited" && (f.after ?? "").includes("99.9") && (f.context ?? "").includes("99.9"))).toBe(true);
  }, 300_000);

  it("a document the engine does not recognise fails the job and stores nothing", async () => {
    const pdfPath = path.join(mkdtempSync(path.join(os.tmpdir(), "tmc-x-")), "letter.pdf");
    execFileSync(python!, [
      "-c",
      'from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.drawString(72,720,"Dear customer, thank you for your order and kind regards from all of us here."); c.save()',
      pdfPath,
    ]);
    await createJobs(db, storage, willem, [
      { route: "auto", entity: "TMC", supplierFile: await upload(new Uint8Array(readFileSync(pdfPath)), "letter.pdf") },
    ]);
    await processNeutraliseJob(db, storage, (await claimNextJob(db))!);
    const [failed] = await db.select().from(jobs);
    expect(failed.state).toBe("failed");
    expect(failed.log).toMatch(/not recognised/);
    expect(await db.select().from(documents)).toHaveLength(0);
  }, 120_000);
});
