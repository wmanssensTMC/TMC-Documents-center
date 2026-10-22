// Vercel Blob client uploads: the browser sends the file straight to private storage
// (no 4.5 MB function limit). This route only hands out a short-lived token, after checking
// login, the storage key and the allowed file types/size for that slot.
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { apiUser } from "@/lib/auth";
import { ALLOWED_TYPES, MAX_FILE_BYTES, parseUploadKey, USER_UPLOAD_KINDS } from "@/lib/files";

export async function POST(request: Request) {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const user = await apiUser();
        if (!user) throw new Error("not logged in");
        const ref = parseUploadKey(pathname);
        if (!ref || !USER_UPLOAD_KINDS.includes(ref.kind)) throw new Error("invalid upload key");
        return {
          allowedContentTypes: ALLOWED_TYPES[ref.kind],
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + 10 * 60 * 1000,
        };
      },
    });
    return Response.json(result);
  } catch {
    return Response.json({ error: "upload refused" }, { status: 400 });
  }
}
