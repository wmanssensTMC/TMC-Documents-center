import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { auditLog } from "../db/schema";
import { newUploadKey } from "../files";
import type { Storage } from "../storage";
import { createDocument, DocumentError, getVersions, listDocuments } from "./service";
import type { DocumentInput } from "./input";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0]);

function fakeStorage(files: Map<string, { bytes: Uint8Array; size?: number }>): Storage {
  return {
    mode: "local",
    async put() {},
    async get() {
      return null;
    },
    async head(key) {
      const f = files.get(key);
      return f ? { bytes: f.bytes, size: f.size ?? f.bytes.length } : null;
    },
  };
}

const willem: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };

let db: Db;
let files: Map<string, { bytes: Uint8Array; size?: number }>;
let storage: Storage;

function upload(kind: "pdf" | "docx" | "source", bytes = kind === "docx" ? DOCX : PDF, size?: number) {
  const key = newUploadKey(kind);
  files.set(key, { bytes, size });
  return { key, filename: `file.${kind === "docx" ? "docx" : "pdf"}` };
}

function coa(over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    type: "COA",
    entity: "TMC",
    productName: "Betaine AI test",
    fileNr: "840.S0850",
    batch: "BT-3877",
    files: { pdf: upload("pdf") },
    ...over,
  };
}

beforeEach(async () => {
  db = await createPgliteDb();
  files = new Map();
  storage = fakeStorage(files);
});

describe("createDocument", () => {
  it("stores a Final document with the engine's file name", async () => {
    const r = await createDocument(db, storage, willem, coa());
    expect(r).toMatchObject({ name: "TMC_COA_840.S0850_Betaine_AI_test_BT-3877", version: 1, supersededVersion: null });
    const [doc] = await listDocuments(db, {});
    expect(doc).toMatchObject({ status: "Final", createdBy: willem.email, approvedBy: willem.email });
  });

  it("never overwrites: same name gives version 2 and supersedes version 1", async () => {
    const first = await createDocument(db, storage, willem, coa());
    const second = await createDocument(db, storage, willem, coa());
    expect(second).toMatchObject({ version: 2, supersededVersion: 1 });

    const versions = await getVersions(db, second.name);
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, "Final"],
      [1, "Superseded"],
    ]);
    // Old version stays retrievable, but the library shows only the current one by default.
    expect((await listDocuments(db, {})).map((d) => d.id)).toEqual([second.id]);
    expect((await listDocuments(db, { status: "Superseded" })).map((d) => d.id)).toEqual([first.id]);
  });

  it("the database itself refuses two current versions of one name", async () => {
    const r = await createDocument(db, storage, willem, coa());
    await expect(
      db.execute(sql`insert into documents (name, type, product_name, status, pdf_key, pdf_filename, created_by, version)
                     values (${r.name}, 'COA', 'x', 'Final', 'k', 'f', 'x', 9)`),
    ).rejects.toThrow();
  });

  it("refuses an upload whose content is not a PDF (renamed file)", async () => {
    await expect(createDocument(db, storage, willem, coa({ files: { pdf: upload("pdf", EXE) } }))).rejects.toThrow(
      DocumentError,
    );
  });

  it("refuses a file over 25 MB", async () => {
    const big = upload("pdf", PDF, 26 * 1024 * 1024);
    await expect(createDocument(db, storage, willem, coa({ files: { pdf: big } }))).rejects.toThrow(/25 MB/);
  });

  it("refuses a storage key that is not an upload key (path tricks)", async () => {
    for (const key of ["../../etc/passwd", "uploads/../secret", "documents/x/pdf", ""]) {
      await expect(
        createDocument(db, storage, willem, coa({ files: { pdf: { key, filename: "a.pdf" } } })),
      ).rejects.toThrow(/invalid upload reference/);
    }
  });

  it("refuses a docx key in the pdf slot", async () => {
    const docx = upload("docx");
    await expect(createDocument(db, storage, willem, coa({ files: { pdf: docx } }))).rejects.toThrow(
      /invalid upload reference/,
    );
  });

  it("refuses re-using another document's uploaded file", async () => {
    const pdf = upload("pdf");
    await createDocument(db, storage, willem, coa({ files: { pdf } }));
    await expect(createDocument(db, storage, willem, coa({ batch: "OTHER", files: { pdf } }))).rejects.toThrow(
      /already belongs/,
    );
  });

  it("requires a product name and rejects types without a naming rule", async () => {
    await expect(createDocument(db, storage, willem, coa({ productName: "  " }))).rejects.toThrow(DocumentError);
    await expect(
      createDocument(db, storage, willem, { ...coa(), type: "LABEL" as unknown as "COA" }),
    ).rejects.toThrow(DocumentError);
  });

  it("rejects oversized and control-character input", async () => {
    await expect(createDocument(db, storage, willem, coa({ productName: "x".repeat(201) }))).rejects.toThrow(
      DocumentError,
    );
    await expect(createDocument(db, storage, willem, coa({ batch: "a\u0000b" }))).rejects.toThrow(DocumentError);
    await expect(createDocument(db, storage, willem, coa({ manufacturingDate: "31/12/2026" }))).rejects.toThrow(
      DocumentError,
    );
  });

  it("writes audit lines for create and supersede", async () => {
    await createDocument(db, storage, willem, coa());
    await createDocument(db, storage, willem, coa());
    const actions = (await db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(["document.created", "document.created", "document.superseded"]);
  });
});

describe("audit log", () => {
  it("is append-only: update and delete are refused by the database", async () => {
    await createDocument(db, storage, willem, coa());
    const reason = (p: Promise<unknown>) =>
      p.then(
        () => "allowed",
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(await reason(db.execute(sql`update audit_log set actor = 'x'`))).toMatch(/append-only/);
    expect(await reason(db.execute(sql`delete from audit_log`))).toMatch(/append-only/);
    expect(await reason(db.execute(sql`truncate audit_log`))).toMatch(/append-only/);
  });
});

describe("listDocuments", () => {
  it("searches across name, product, batch, dossier and supplier; % and _ are literal", async () => {
    await createDocument(db, storage, willem, coa({ supplierName: "Acme Chem" }));
    await createDocument(db, storage, willem, coa({ productName: "Glycerin", batch: "G-1" }));
    expect(await listDocuments(db, { q: "acme" })).toHaveLength(1);
    expect(await listDocuments(db, { q: "840.S0850" })).toHaveLength(2);
    expect(await listDocuments(db, { product: "glyc" })).toHaveLength(1);
    expect(await listDocuments(db, { q: "%" })).toHaveLength(0);
    expect(await listDocuments(db, { q: "_" })).toHaveLength(2); // names contain "_"
  });
});
