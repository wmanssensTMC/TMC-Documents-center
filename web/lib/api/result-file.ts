// v1.1 (contract section 15.3): the PDF of one Final result, for a coordinator's click "Add to
// draft" in TMC Logistics. Only Final (never a draft, a To check, a Superseded, the Word file, the
// source or a supplier document), only for the key that made the job, with its SHA-256.
import "server-only";
import { createHash } from "node:crypto";
import { logAudit } from "../audit";
import type { Db } from "../db";
import { MAX_FILE_MB } from "../files";
import type { Storage } from "../storage";
import { ApiError } from "./errors";
import { platformMaxBytes } from "./http";
import type { ApiCaller } from "./keys";
import { ownRequest, rollupMany, transmareEmail } from "./requests";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Final PDF of a result, or a fixed error. Read whole (within the limit) so its hash goes first. */
export async function finalResultFile(db: Db, storage: Storage, caller: ApiCaller, jobId: string, documentId: string, requestedByHeader: string | null) {
  const requestedBy = transmareEmail.safeParse(requestedByHeader ?? "");
  if (!requestedBy.success) throw new ApiError("invalid_payload", ["X-Requested-By"]);
  const row = await ownRequest(db, caller, jobId);
  if (!UUID.test(documentId)) throw new ApiError("not_found");
  const doc = (await rollupMany(db, [row])).get(row.id)!.documents.find((d) => d.id === documentId.toLowerCase());
  if (!doc) throw new ApiError("not_found"); // not a result of this job
  if (doc.status !== "Final" || !doc.pdfKey) throw new ApiError("not_final");

  const max = Math.min(MAX_FILE_MB.pdf * 1024 * 1024, platformMaxBytes());
  const file = await storage.get(doc.pdfKey);
  if (!file) throw new ApiError("unavailable");
  if (file.size !== null && file.size > max) {
    await file.stream.cancel();
    throw new ApiError("file_too_large");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = file.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new ApiError("file_too_large");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ApiError("unavailable"); // never anything but a PDF
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await logAudit(db, { email: `${caller.client}:${requestedBy.data.toLowerCase()}` }, "api.result.file.read", doc.id, {
    client: caller.client,
    requestedBy: requestedBy.data.toLowerCase(),
    apiJob: row.id,
    document: doc.id,
  });
  return { bytes, sha256, name: doc.name };
}

/** Content-Disposition with the document name; the ASCII form for old readers, UTF-8 beside it. */
export function attachmentHeader(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(`${name}.pdf`)}`;
}
