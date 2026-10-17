// Browser side of an upload: straight to private Vercel Blob online, to /api/upload-local on a
// laptop. Returns the storage key; the server checks the file again before using it.
import { upload } from "@vercel/blob/client";
import { newUploadKey, type FileKind } from "./files";

export async function sendFile(mode: "blob" | "local", kind: FileKind, file: File): Promise<string> {
  if (mode === "blob") {
    const key = newUploadKey(kind);
    await upload(key, file, {
      access: "private",
      handleUploadUrl: "/api/upload",
      contentType: file.type || undefined,
      multipart: file.size > 5 * 1024 * 1024,
    });
    return key;
  }
  const res = await fetch("/api/upload-local", { method: "POST", body: file, headers: { "x-upload-kind": kind } });
  const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
  if (!res.ok || !json.key) throw new Error(json.error ?? "upload failed");
  return json.key;
}
