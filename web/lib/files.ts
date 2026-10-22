// What may be uploaded, per file slot. Checked twice: before the upload (type, size)
// and after it, on the stored bytes (file signature), so a renamed .exe is refused.

// pdf/docx/source: files of a library document. input: a supplier or commercial document
// for a neutralise job (the engine reads PDFs).
// preview: an engine draft rendered to PDF with a DRAFT stamp, shown on the check screen only.
// view: the on-screen editor's view of an engine draft (JSON, made by the worker only).
export const FILE_KINDS = ["pdf", "docx", "source", "input", "preview", "view"] as const;
export const DOCUMENT_FILE_KINDS = ["pdf", "docx", "source", "preview", "view"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
/** What a person may upload; preview and view are made by the worker only. */
export const USER_UPLOAD_KINDS: readonly FileKind[] = ["pdf", "docx", "source", "input"];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PNG = "image/png";
const JPEG = "image/jpeg";
const JSON_TYPE = "application/json";

const SIGNATURES: Record<string, number[]> = {
  [PDF]: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [DOCX]: [0x50, 0x4b, 0x03, 0x04], // PK.. (zip)
  [PNG]: [0x89, 0x50, 0x4e, 0x47],
  [JPEG]: [0xff, 0xd8, 0xff],
  [JSON_TYPE]: [0x7b], // {
};

export const ALLOWED_TYPES: Record<FileKind, string[]> = {
  pdf: [PDF],
  docx: [DOCX],
  source: [PDF, DOCX, PNG, JPEG],
  input: [PDF],
  preview: [PDF],
  view: [JSON_TYPE],
};

export const EXTENSION: Record<string, string> = { [PDF]: ".pdf", [DOCX]: ".docx", [PNG]: ".png", [JPEG]: ".jpg", [JSON_TYPE]: ".json" };

/** Storage key for a new upload: uploads/<uuid>/<kind>. Nothing from the user goes in it. */
export function newUploadKey(kind: FileKind, id: string = crypto.randomUUID()) {
  return `uploads/${id}/${kind}`;
}

const KEY_RE = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(pdf|docx|source|input|preview|view)$/;

export function parseUploadKey(key: unknown): { key: string; kind: FileKind } | null {
  if (typeof key !== "string") return null;
  const m = KEY_RE.exec(key);
  return m ? { key, kind: m[1] as FileKind } : null;
}

/** Which allowed type the first bytes match, or null. */
export function detectType(kind: FileKind, head: Uint8Array): string | null {
  for (const type of ALLOWED_TYPES[kind]) {
    const sig = SIGNATURES[type];
    if (head.length >= sig.length && sig.every((b, i) => head[i] === b)) return type;
  }
  return null;
}

/** Original file name for display only: no path, no control characters, max 200. */
export function cleanFilename(name: unknown): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  return Array.from(base.replace(/[\u0000-\u001f\u007f]/g, "").trim()).slice(0, 200).join("") || "file";
}
