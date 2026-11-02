"use server";

import { redirect } from "next/navigation";
import { ApiKeyError, createApiKey, deactivateApiKey } from "@/lib/api/keys";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const PAGE = "/settings/api-keys";

export type NewKeyResult = { ok: true; key: string } | { ok: false; error: string } | null;

/** The key goes back to the admin's browser once, never in a URL, a log or the database. */
export async function makeKey(_prev: NewKeyResult, formData: FormData): Promise<NewKeyResult> {
  const admin = await requireUser("admin");
  try {
    const { key } = await createApiKey(await getDb(), admin, {
      client: String(formData.get("client") ?? ""),
      allowedKinds: formData.getAll("kinds").map(String),
    });
    return { ok: true, key };
  } catch (err) {
    if (err instanceof ApiKeyError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function deactivateKey(formData: FormData) {
  const admin = await requireUser("admin");
  try {
    await deactivateApiKey(await getDb(), admin, String(formData.get("id")));
  } catch (err) {
    if (err instanceof ApiKeyError) redirect(`${PAGE}?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect(`${PAGE}?ok=${encodeURIComponent("Key deactivated. Calls with it are refused from now on.")}`);
}
