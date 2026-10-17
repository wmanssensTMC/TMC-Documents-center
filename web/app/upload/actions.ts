"use server";

import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createDocument, DocumentError } from "@/lib/documents/service";
import type { DocumentInput } from "@/lib/documents/input";
import { getStorage } from "@/lib/storage";

export type SaveResult = { ok: true; id: string; message: string } | { ok: false; error: string };

export async function saveDocument(input: DocumentInput): Promise<SaveResult> {
  const user = await requireUser();
  try {
    const r = await createDocument(await getDb(), getStorage(), user, input);
    const message = r.supersededVersion
      ? `${r.name} already existed (version ${r.supersededVersion}). Saved as version ${r.version}; version ${r.supersededVersion} is now Superseded and stays available.`
      : `Saved as ${r.name}.`;
    return { ok: true, id: r.id, message };
  } catch (err) {
    if (err instanceof DocumentError) return { ok: false, error: err.message };
    console.error("saveDocument failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "Saving failed. Try again or tell the administrator." };
  }
}
