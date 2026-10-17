"use server";

import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createJobs, JobError, type JobInput } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";

export type CreateJobsResult = { ok: true; count: number } | { ok: false; error: string };

export async function submitJobs(inputs: JobInput[]): Promise<CreateJobsResult> {
  const user = await requireUser();
  try {
    const ids = await createJobs(await getDb(), getStorage(), user, inputs);
    return { ok: true, count: ids.length };
  } catch (err) {
    if (err instanceof JobError) return { ok: false, error: err.message };
    console.error("submitJobs failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "Sending the documents failed. Try again or tell the administrator." };
  }
}
