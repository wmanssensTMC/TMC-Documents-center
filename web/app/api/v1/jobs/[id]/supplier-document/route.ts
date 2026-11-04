// PUT /api/v1/jobs/{id}/supplier-document (v1.1, contract 15.1): the one supplier document a
// coordinator chose, as raw bytes. Never the file name or the bytes in the answer.
import { json, withApiKey } from "@/lib/api/http";
import { handOverSupplierDocument } from "@/lib/api/supplier-document";
import { getStorage } from "@/lib/storage";

export async function PUT(req: Request, ctx: RouteContext<"/api/v1/jobs/[id]/supplier-document">) {
  return withApiKey(req, "handoff", async ({ db, caller }) => {
    const { body, created } = await handOverSupplierDocument(db, getStorage(), caller, (await ctx.params).id, req);
    return json(body, created ? 201 : 200);
  });
}
