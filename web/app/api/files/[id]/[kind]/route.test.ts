import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the external ports are stubbed: login, database, document lookup, file storage, audit log.
const getDocument = vi.fn();
const head = vi.fn();
const get = vi.fn();
const apiUser = vi.fn();
const logAudit = vi.fn();
vi.mock("@/lib/auth", () => ({ apiUser: () => apiUser() }));
vi.mock("@/lib/db", () => ({ getDb: async () => ({}) }));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock("@/lib/documents/service", () => ({ getDocument: (...a: unknown[]) => getDocument(...a) }));
vi.mock("@/lib/storage", () => ({ getStorage: () => ({ mode: "local", head, get, put: vi.fn() }) }));

const { GET } = await import("./route");

const ID = "11111111-2222-3333-4444-555555555555";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const doc = (status: string) => ({
  id: ID,
  name: "TMC_COA_840.S0850_Betaine_BT-3877",
  status,
  pdfKey: "uploads/a/pdf",
  docxKey: null,
  sourceKey: "uploads/a/source",
  sourceFilename: "original.pdf",
  previewKey: "uploads/a/preview",
  viewKey: null,
});
const file = () => ({ stream: new Blob([PDF_BYTES]).stream(), size: PDF_BYTES.length, contentType: "application/pdf" });
const call = async (kind: string) => {
  const p = GET(new Request(`http://localhost/api/files/${ID}/${kind}`), { params: Promise.resolve({ id: ID, kind }) } as never);
  p.catch(() => {}); // the failure is asserted by the caller; avoids an "unhandled" warning meanwhile
  await vi.runAllTimersAsync(); // lets the 800 ms retry pause pass without waiting for real
  return p;
};
const fail = () => Promise.reject(new Error("fetch failed"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  apiUser.mockResolvedValue({ email: "test@transmare.com", role: "user" });
  getDocument.mockResolvedValue(doc("Final"));
  head.mockResolvedValue({ bytes: PDF_BYTES, size: PDF_BYTES.length });
  get.mockImplementation(async () => file());
});
afterEach(() => vi.useRealTimers());

describe("GET /api/files/[id]/[kind]: retry once on a cold start (26/10/2026)", () => {
  it("serves the file when nothing fails", async () => {
    const res = await call("source");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it("recovers when the document lookup fails once", async () => {
    getDocument.mockImplementationOnce(fail);
    const res = await call("source");
    expect(res.status).toBe(200);
    expect(getDocument).toHaveBeenCalledTimes(2);
  });

  it("recovers when reading the file's first bytes fails once", async () => {
    head.mockImplementationOnce(fail);
    const res = await call("source");
    expect(res.status).toBe(200);
    expect(head).toHaveBeenCalledTimes(2);
  });

  it("recovers when fetching the file fails once", async () => {
    get.mockImplementationOnce(fail);
    const res = await call("source");
    expect(res.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("still fails when the document lookup keeps failing, and logs no access", async () => {
    getDocument.mockImplementation(fail);
    await expect(call("source")).rejects.toThrow("fetch failed");
    expect(getDocument).toHaveBeenCalledTimes(2);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("still fails when storage keeps failing, and serves nothing", async () => {
    get.mockImplementation(fail);
    await expect(call("source")).rejects.toThrow("fetch failed");
    expect(get).toHaveBeenCalledTimes(2);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("does not retry a file that is really missing", async () => {
    head.mockResolvedValue(null);
    const res = await call("source");
    expect(res.status).toBe(404);
    expect(head).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/[id]/[kind]: the DRAFT preview only while To check (review H1)", () => {
  it("serves the preview inline while the document waits for its check", async () => {
    getDocument.mockResolvedValue(doc("To check"));
    const res = await call("preview");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
  });

  it.each(["Final", "Superseded", "Draft"])("refuses the preview once the status is %s", async (status) => {
    getDocument.mockResolvedValue(doc(status));
    const res = await call("preview");
    expect(res.status).toBe(404);
    expect(head).not.toHaveBeenCalled();
  });

  it("refuses the preview of a Final document even when the first lookup failed", async () => {
    getDocument.mockImplementationOnce(fail).mockResolvedValue(doc("Final"));
    const res = await call("preview");
    expect(res.status).toBe(404);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/[id]/[kind]: guards before any lookup", () => {
  it("refuses a visitor who is not logged in", async () => {
    apiUser.mockResolvedValue(null);
    const res = await call("source");
    expect(res.status).toBe(401);
    expect(getDocument).not.toHaveBeenCalled();
  });

  it.each(["input", "../pdf", "PDF", "", "pdf%00", "préview"])("refuses unknown file kind %j", async (kind) => {
    const res = await call(kind);
    expect(res.status).toBe(404);
    expect(getDocument).not.toHaveBeenCalled();
  });
});
