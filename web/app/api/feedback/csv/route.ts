// Feedback export for Excel (admin only). Semicolons, UTF-8 with BOM so Excel shows é and ü.
import { logAudit } from "@/lib/audit";
import { apiUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { feedbackLines, periodFromDays, toCsv } from "@/lib/feedback";

export async function GET(req: Request) {
  const admin = await apiUser("admin");
  if (!admin) return new Response("Not allowed", { status: 403 });
  const days = Number(new URL(req.url).searchParams.get("days")) || 30;
  const db = await getDb();
  const rows = await feedbackLines(db, periodFromDays(days), ["corrected", "edited", "rejected", "word_upload"], 5000);
  await logAudit(db, admin, "feedback.exported", null, { days, rows: rows.length });
  const csv = toCsv(rows, ["at", "actor", "kind", "name", "type", "context", "before", "after", "reason"]);
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tmc-feedback-${days}d.csv"`,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}
