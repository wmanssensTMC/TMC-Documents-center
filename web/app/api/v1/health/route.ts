// GET /api/v1/health (contract section 4): no key, nothing but "ok".
export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
