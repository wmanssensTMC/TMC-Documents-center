"use server";

import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createLabelJob, LabelError, type LabelInput } from "@/lib/labels";

export type CreateLabelResult = { ok: true } | { ok: false; error: string };

export async function submitLabel(input: LabelInput): Promise<CreateLabelResult> {
  const user = await requireUser();
  try {
    await createLabelJob(await getDb(), user, input);
    return { ok: true };
  } catch (err) {
    if (err instanceof LabelError) return { ok: false, error: err.message };
    console.error("submitLabel failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "Sending the label failed. Try again or tell the administrator." };
  }
}
