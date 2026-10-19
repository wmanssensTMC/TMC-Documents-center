"use server";

import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { approveDraft, CheckError, rejectDraft, requestFinalise } from "@/lib/documents/check";
import { getStorage } from "@/lib/storage";

export type CheckResult = { ok: true; message: string } | { ok: false; error: string };

async function run(fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { ok: true, message: await fn() };
  } catch (err) {
    if (err instanceof CheckError) return { ok: false, error: err.message };
    console.error("check action failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "That did not work. Try again or tell the administrator." };
  }
}

// Anyone may check and finalise engine drafts (Willem 17/10).
export async function finaliseDraft(documentId: string, input: unknown): Promise<CheckResult> {
  const user = await requireUser();
  return run(async () => {
    await requestFinalise(await getDb(), getStorage(), user, documentId, input);
    return "Sent for finalising. The PDF is made by the neutralizer; this page updates itself.";
  });
}

export async function approve(documentId: string, metadata: unknown): Promise<CheckResult> {
  const user = await requireUser();
  return run(async () => {
    await approveDraft(await getDb(), user, documentId, metadata);
    return "Sent for approval. The neutralizer checks the details against the document; this page updates itself.";
  });
}

export async function reject(documentId: string, reason: unknown): Promise<CheckResult> {
  const user = await requireUser();
  return run(async () => {
    await rejectDraft(await getDb(), user, documentId, reason);
    return "Draft rejected. The reason is kept for the feedback overview.";
  });
}
