"use server";

import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { JobError, rerunJob } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";

export type RerunResult = { ok: true } | { ok: false; error: string };

// Anyone logged in may run a draft again, as anyone may check one (Willem 02/11).
export async function rerunDraft(documentId: string): Promise<RerunResult> {
  const user = await requireUser();
  try {
    await rerunJob(await getDb(), getStorage(), user, String(documentId));
    return { ok: true };
  } catch (err) {
    if (err instanceof JobError) return { ok: false, error: err.message };
    console.error("rerunDraft failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "That did not work. Try again or tell the administrator." };
  }
}
