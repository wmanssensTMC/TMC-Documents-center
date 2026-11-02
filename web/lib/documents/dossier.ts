// Dossier overview (Willem 02/11): everything made for one TMC file nr (dossier or PO number) on
// one page: the neutralise jobs, the drafts and the Finals.
import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { documents } from "../db/schema";

/**
 * The file nr as typed on documents and jobs (at most 50 characters, the jobs' own limit), or
 * null. It only goes into a query parameter and the page text, so any file nr a check screen
 * accepts works here too, "/" and a leading "-" included (review L1); control characters (C0 and
 * C1) are refused. The value comes from `?nr=`, which is decoded exactly once (review L2).
 */
export function dossierFileNr(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > 50 || /[\u0000-\u001f\u007f-\u009f]/.test(v)) return null;
  return v;
}

/** The link to a dossier's overview. */
export function dossierHref(fileNr: string) {
  return `/dossiers?${new URLSearchParams({ nr: fileNr })}`;
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
      // counted in the database: the parts themselves are not needed here (review L5)
      yellowCount: sql<number>`coalesce(jsonb_array_length(${documents.yellowParts}), 0)`.mapWith(Number),
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.fileNr, fileNr))
    .orderBy(desc(documents.createdAt))
    .limit(200);
}
