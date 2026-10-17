// Append-only audit trail (BRIEF 6). The database refuses updates and deletes.
import type { Db } from "./db";
import { auditLog } from "./db/schema";

export type Actor = { email: string; name: string; role: "admin" | "approver" | "user" };

type Tx = Pick<Db, "insert">;

export async function logAudit(
  db: Tx,
  actor: Pick<Actor, "email">,
  action: string,
  documentId?: string | null,
  details?: Record<string, unknown>,
) {
  await db.insert(auditLog).values({ actor: actor.email, action, documentId: documentId ?? null, details: details ?? null });
}
