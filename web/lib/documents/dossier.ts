// Dossier overview (Willem 02/11): everything made for one TMC file nr (dossier or PO number) on
// one page: the neutralise jobs, the drafts and the Finals.
import "server-only";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { documents } from "../db/schema";

/**
 * The file nr as typed on documents and jobs (at most 50 characters, the jobs' own limit), or
 * null. It only ever goes into a query parameter and the page text; slashes and control
 * characters are refused so a link can never point anywhere else.
 */
export function dossierFileNr(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 50 || v.startsWith("-") || /[\u0000-\u001f\u007f/\\]/.test(v)) return null;
  return v;
}

/** Drafts and Finals of a dossier, newest first. */
export async function getDossierDocuments(db: Db, fileNr: string) {
  return db
    .select({
      id: documents.id,
      name: documents.name,
      type: documents.type,
      status: documents.status,
      version: documents.version,
      batch: documents.batch,
      yellowParts: documents.yellowParts,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.fileNr, fileNr))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}
