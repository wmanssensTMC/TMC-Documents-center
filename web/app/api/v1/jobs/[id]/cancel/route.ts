// POST /api/v1/jobs/{id}/cancel: "Not needed" in TMC Logistics (contract section 9), idempotent.
import { json, readJson, withApiKey } from "@/lib/api/http";
import { cancelRequest } from "@/lib/api/requests";

export async function POST(req: Request, ctx: RouteContext<"/api/v1/jobs/[id]/cancel">) {
  return withApiKey(req, "create", async ({ db, caller }) => json(await cancelRequest(db, caller, (await ctx.params).id, await readJson(req))));
}
