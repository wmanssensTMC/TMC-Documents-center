// GET /api/v1/jobs/{id}/results/{documentId}/file (v1.1, contract 15.3): the PDF of a Final result.
import { withApiKey } from "@/lib/api/http";
import { attachmentHeader, finalResultFile } from "@/lib/api/result-file";
import { getStorage } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/v1/jobs/[id]/results/[documentId]/file">) {
  return withApiKey(req, "read", async ({ db, caller }) => {
    const { id, documentId } = await ctx.params;
    const file = await finalResultFile(db, getStorage(), caller, id, documentId, req.headers.get("x-requested-by"));
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(file.bytes.length),
        "content-disposition": attachmentHeader(file.name),
        "x-content-sha256": file.sha256,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
