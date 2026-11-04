"use server";

import { redirect } from "next/navigation";
import { getRequestForPage, RequestError } from "@/lib/api/requests";
import { startEngine } from "@/lib/api/supplier-document";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { JobError } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";

/** v1.1: a person types the supplier name for the document TMC Logistics handed over, and starts the run. */
export async function startHandedOver(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const page = `/api-jobs/${encodeURIComponent(id)}`;
  const db = await getDb();
  const req = await getRequestForPage(db, id);
  if (!req) redirect("/api-jobs");
  // a run already made from it is not made twice (also checked under the row lock in createJobs)
  if (req.state !== "waiting-input" || !req.handOffPending) redirect(`${page}?error=${encodeURIComponent("This document was already sent to the neutralizer.")}`);
  const text = (k: string) => String(formData.get(k) ?? "");
  try {
    await startEngine(db, getStorage(), user, req, text("supplierName"), {
      productName: text("productName"),
      fileNr: text("fileNr"),
      batch: text("batch"),
    });
  } catch (err) {
    if (err instanceof JobError || err instanceof RequestError) redirect(`${page}?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect(`${page}?ok=${encodeURIComponent("Sent to the neutralizer.")}`);
}
