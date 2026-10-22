import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { jobs, type Document } from "../db/schema";
import { changeWarnings, type Change } from "./changes";
import { editsInput, type Edits } from "./edits";

/**
 * The last on-screen edit of a draft that did not become Final (warnings to confirm, yellow left,
 * a refused check): its changes and any warnings, so the person goes on from there without
 * losing the work. Null otherwise.
 */
export async function pendingEdit(db: Db, doc: Document): Promise<{ edits: Edits; warnings: Change[] } | null> {
  if (doc.status !== "To check") return null;
  const [last] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.documentId, doc.id), eq(jobs.kind, "finalise")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!last || last.state !== "failed" || last.payload?.mode !== "edited") return null;
  const edits = editsInput.safeParse(last.payload.edits);
  if (!edits.success) return null; // an edit saved before the own editor (20/10): nothing to go on from
  return { edits: edits.data, warnings: changeWarnings(last.log) ?? [] };
}
