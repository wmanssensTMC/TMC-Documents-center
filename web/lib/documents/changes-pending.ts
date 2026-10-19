import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { jobs, type Document } from "../db/schema";
import { changeWarnings, type Change } from "./changes";

/**
 * The last on-screen edit of a draft that did not become Final (warnings to confirm, yellow left,
 * a refused check): its Word file and any warnings, so the person goes on from there without
 * losing the work. Null otherwise.
 */
export async function pendingEdit(db: Db, doc: Document): Promise<{ key: string; filename: string; warnings: Change[] } | null> {
  if (doc.status !== "To check") return null;
  const [last] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.documentId, doc.id), eq(jobs.kind, "finalise")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!last || last.state !== "failed" || last.payload?.mode !== "edited") return null;
  return { key: last.payload.docx.key, filename: last.payload.docx.filename, warnings: changeWarnings(last.log) ?? [] };
}
