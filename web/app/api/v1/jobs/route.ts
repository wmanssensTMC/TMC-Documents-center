// POST /api/v1/jobs: a calling app asks for one document job (contract sections 5, 6, 8).
// GET /api/v1/jobs?ids=a,b: the states of up to 100 of its own jobs (contract section 7).
import { json, readJson, withApiKey } from "@/lib/api/http";
import { createRequest, getRequests } from "@/lib/api/requests";

export async function POST(req: Request) {
  return withApiKey(req, "create", async ({ db, caller }) => {
    const { job, created } = await createRequest(db, caller, req.headers.get("idempotency-key"), await readJson(req));
    return json(job, created ? 201 : 200);
  });
}

export async function GET(req: Request) {
  return withApiKey(req, "read", async ({ db, caller }) => {
    return json({ jobs: await getRequests(db, caller, new URL(req.url).searchParams.get("ids")) });
  });
}
