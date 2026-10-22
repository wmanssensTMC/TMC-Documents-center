// Laptop only (no Vercel Blob): stores an upload in .data/files. Disabled online.
import { apiUser } from "@/lib/auth";
import { detectType, MAX_FILE_BYTES, newUploadKey, USER_UPLOAD_KINDS, type FileKind } from "@/lib/files";
import { getStorage, putLocal } from "@/lib/storage";

export async function POST(request: Request) {
  if (getStorage().mode !== "local" || process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }
  const user = await apiUser();
  if (!user) return new Response("Not logged in", { status: 401 });

  const kind = USER_UPLOAD_KINDS.find((k) => k === request.headers.get("x-upload-kind")) as FileKind | undefined;
  if (!kind) return Response.json({ error: "unknown file slot" }, { status: 400 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES) {
    return Response.json({ error: "file is larger than 25 MB" }, { status: 413 });
  }
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MAX_FILE_BYTES) return Response.json({ error: "file is larger than 25 MB" }, { status: 413 });
  if (!detectType(kind, data.subarray(0, 8))) return Response.json({ error: "file type not allowed" }, { status: 415 });

  const key = newUploadKey(kind);
  await putLocal(key, data);
  return Response.json({ key });
}
