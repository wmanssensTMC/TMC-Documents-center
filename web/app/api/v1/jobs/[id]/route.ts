// GET /api/v1/jobs/{id}: the state of one of the caller's own jobs (another client's = 404).
import { json, withApiKey } from "@/lib/api/http";
import { getRequest } from "@/lib/api/requests";

export async function GET(req: Request, ctx: RouteContext<"/api/v1/jobs/[id]">) {
  return withApiKey(req, "read", async ({ db, caller }) => json(await getRequest(db, caller, (await ctx.params).id)));
}
