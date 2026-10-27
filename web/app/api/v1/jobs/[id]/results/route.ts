// GET /api/v1/jobs/{id}/results: references to the result documents (contract 4.2), no files.
import { json, withApiKey } from "@/lib/api/http";
import { requestResults } from "@/lib/api/requests";

export async function GET(req: Request, ctx: RouteContext<"/api/v1/jobs/[id]/results">) {
  return withApiKey(req, "read", async ({ db, caller }) => json({ results: await requestResults(db, caller, (await ctx.params).id) }));
}
