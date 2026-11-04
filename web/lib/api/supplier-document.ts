// v1.1 (contract section 15.1): TMC Logistics hands over the one supplier document a coordinator
// chose from the shipment's mail. It is stored as a supplier original (internal) on the request;
// the engine starts as soon as a supplier name is known (sent with the job, or typed by a person
// on the request page). The provenance gate, yellow, Final by a person and the file names do not
// change: the run is an ordinary neutralise job, made by the same code as the app's own form.
import "server-only";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { logAudit, type Actor } from "../audit";
import { API_KIND_ROUTE, type Route } from "../constants";
import type { Db } from "../db";
import { apiJobs, type ApiJob, type ApiSupplierFile } from "../db/schema";
import { cleanFilename, newUploadKey } from "../files";
import { createJobs, JobError } from "../jobs";
import type { Storage } from "../storage";
import { ApiError } from "./errors";
import { platformMaxBytes, readBytes } from "./http";
import type { ApiCaller } from "./keys";
import { jobView, ownRequest, RequestError, rollupMany, type JobView } from "./requests";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/**
 * The engine reads PDF supplier documents only, so a DOCX is refused (contract 15.1: "DC may refuse
 * DOCX for a route its engine cannot read"). A DOCX-to-PDF step in the worker can add it later.
 */
const ACCEPTED: readonly string[] = [PDF];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE_NAME = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}\p{Cf}/\\]/u;

/** X-File-Name: percent-encoded UTF-8, 1..200 characters, no path separators or control characters. */
export function fileNameHeader(raw: string | null): string {
  let name: string;
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    throw new ApiError("invalid_payload", ["X-File-Name"]);
  }
  if (!name.trim() || [...name].length > 200 || UNSAFE_NAME.test(name)) throw new ApiError("invalid_payload", ["X-File-Name"]);
  return cleanFilename(name);
}

/** What the bytes really are (never the header): only a PDF passes. */
function realType(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  if (head === "%PDF-") return PDF;
  if (head.startsWith("PK\u0003\u0004")) return DOCX;
  return null;
}

const view = (job: JobView, f: ApiSupplierFile) => ({ ...job, supplierDocument: { sha256: f.sha256, size: f.size, contentType: f.contentType } });

async function current(db: Db, row: ApiJob) {
  return jobView(row, (await rollupMany(db, [row])).get(row.id)!);
}

/** PUT /jobs/{id}/supplier-document. `created` false = the same hand-off again (200). */
export async function handOverSupplierDocument(db: Db, storage: Storage, caller: ApiCaller, id: string, req: Request) {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new ApiError("missing_idempotency_key");
  if (!UUID.test(key)) throw new ApiError("invalid_payload", ["Idempotency-Key"]);
  const row = await ownRequest(db, caller, id);
  if (!API_KIND_ROUTE[row.kind]) throw new ApiError("not_accepted_for_kind");

  // the same hand-off again: same bytes = the same answer, other bytes = conflict
  if (row.supplierFile && row.supplierFileKey === key.toLowerCase()) {
    const bytes = await readBytes(req, platformMaxBytes());
    if (createHash("sha256").update(bytes).digest("hex") !== row.supplierFile.sha256) throw new ApiError("idempotency_conflict");
    return { body: view(await current(db, row), row.supplierFile), created: false };
  }
  const state = (await rollupMany(db, [row])).get(row.id)!.state;
  if (row.supplierFile || state !== "waiting-input") throw new ApiError("not_waiting_for_input");

  // the header first, then the length (before a byte is read), then the real content
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== PDF && contentType !== DOCX) throw new ApiError("unsupported_type");
  const filename = fileNameHeader(req.headers.get("x-file-name"));
  const bytes = await readBytes(req, platformMaxBytes());
  const type = realType(bytes);
  if (!type || type !== contentType || !ACCEPTED.includes(type)) throw new ApiError("unsupported_type");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file: ApiSupplierFile = { key: newUploadKey("input"), filename, sha256, size: bytes.length, contentType: type };
  await storage.put(file.key, bytes, type);
  const stored = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(apiJobs).where(eq(apiJobs.id, row.id)).for("update");
    if (locked.cancelledAt || locked.supplierFile) return null; // a cancel or another hand-off came first
    const [updated] = await tx
      .update(apiJobs)
      .set({ supplierFile: file, supplierFileKey: key.toLowerCase() })
      .where(and(eq(apiJobs.id, row.id)))
      .returning();
    await logAudit(tx, { email: row.createdBy }, "api.job.input", null, {
      apiJob: row.id,
      client: caller.client,
      sha256,
      size: bytes.length,
      contentType: type,
    });
    return updated;
  });
  if (!stored) throw new ApiError("not_waiting_for_input");
  if (stored.supplierName) {
    try {
      await startEngine(db, storage, { email: stored.createdBy, name: caller.client, role: "user" }, stored, stored.supplierName);
    } catch (err) {
      // the document is kept; a person starts it on the request page (e.g. too many open runs)
      if (!(err instanceof JobError || err instanceof RequestError)) throw err;
      console.warn("api v1.1: engine not started on hand-off:", err.name);
    }
  }
  return { body: view(await current(db, stored), file), created: true };
}

/**
 * Starts the engine on the handed-over document: from the hand-off when the supplier name came with
 * the job, or from the request page when a person types it. Dossier = the order no; product name =
 * the line's description only when the part has exactly one line (otherwise the engine reads it).
 */
export async function startEngine(
  db: Db,
  storage: Storage,
  actor: Actor,
  req: ApiJob,
  supplierName: string,
  typed: { productName?: string; fileNr?: string; batch?: string } = {},
) {
  const route = API_KIND_ROUTE[req.kind] as Route | null;
  if (!route || !req.supplierFile) throw new RequestError("this request has no supplier document from TMC Logistics");
  const one = req.lines.length === 1 ? req.lines[0] : null;
  return createJobs(db, storage, actor, [
    {
      route,
      entity: req.entity,
      productName: typed.productName ?? one?.description ?? "",
      fileNr: typed.fileNr ?? req.orderNo,
      batch: typed.batch ?? "",
      supplierName,
      supplierFile: { key: req.supplierFile.key, filename: req.supplierFile.filename },
      apiJobId: req.id,
    },
  ]);
}
