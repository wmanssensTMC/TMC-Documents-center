import Link from "next/link";
import { PageShell } from "@/components/app-header";
import { SettingsNav } from "@/components/settings-nav";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { failedJobs, feedbackLines, feedbackSummary, periodFromDays, topCorrections } from "@/lib/feedback";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Feedback · TMC Document Center" };

const PERIODS = [7, 30, 90, 365];

function Tile({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
      <div className="text-2xl font-semibold text-tmc">{value}</div>
      <div className="text-sm text-gray-700">{label}</div>
      {note && <div className="text-xs text-gray-500">{note}</div>}
    </div>
  );
}

export default async function FeedbackPage({ searchParams }: PageProps<"/settings/feedback">) {
  const admin = await requireUser("admin");
  const sp = await searchParams;
  const days = PERIODS.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const period = periodFromDays(days);
  const db = await getDb();
  const [summary, top, corrections, rejections, failed] = await Promise.all([
    feedbackSummary(db, period),
    topCorrections(db, period),
    feedbackLines(db, period, ["corrected", "edited", "word_upload"]),
    feedbackLines(db, period, ["rejected"]),
    failedJobs(db, period),
  ]);
  const cell = "px-3 py-2 align-top";

  return (
    <PageShell user={admin}>
      <SettingsNav current="feedback" />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-tmc">Feedback from the checks</h1>
          <p className="text-sm text-gray-600">
            What people corrected or rejected, to improve the neutralizer&apos;s reading rules. Nothing here changes a
            document.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {PERIODS.map((d) => (
            <Link
              key={d}
              href={`/settings/feedback?days=${d}`}
              className={`rounded px-2 py-1 ${d === days ? "bg-tmc text-white" : "text-tmc underline"}`}
            >
              {d} days
            </Link>
          ))}
          <a href={`/api/feedback/csv?days=${days}`} className="ml-2 rounded-md border border-tmc px-3 py-1 text-tmc hover:bg-tmc-light">
            Download CSV
          </a>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <Tile label="Drafts made" value={summary.drafts} />
        <Tile label="Final via neutralizer" value={summary.finalViaEngine} note="KPI K8" />
        <Tile label="Rejected" value={summary.rejected} />
        <Tile label="Failed runs" value={summary.failedJobs} />
        <Tile label="Yellow parts corrected" value={summary.corrected} note={`${summary.confirmed} confirmed as is`} />
        <Tile label="Corrected share" value={summary.correctedShare === null ? "–" : `${summary.correctedShare}%`} note="of checked yellow parts" />
      </div>

      <section className="mt-6 rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <h2 className="px-4 pt-4 font-semibold">Most frequent corrections</h2>
        <p className="px-4 text-xs text-gray-500">The same text corrected again and again points at a reading rule to improve.</p>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full min-w-[600px] text-left text-sm">
            <thead className="bg-tmc-light text-tmc">
              <tr>
                <th className={cell}>Engine read</th>
                <th className={cell}>Last corrected to</th>
                <th className={cell}>Times</th>
                <th className={cell}>Types</th>
              </tr>
            </thead>
            <tbody>
              {top.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-gray-500">No corrections in this period.</td>
                </tr>
              )}
              {top.map((t, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className={`${cell} font-mono text-xs`}>{t.before}</td>
                  <td className={`${cell} font-mono text-xs`}>{t.lastAfter}</td>
                  <td className={cell}>{t.times}</td>
                  <td className={cell}>{t.types}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <h2 className="px-4 pt-4 font-semibold">All corrections</h2>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full min-w-[800px] text-left text-sm">
            <thead className="bg-tmc-light text-tmc">
              <tr>
                <th className={cell}>When / who</th>
                <th className={cell}>Document</th>
                <th className={cell}>In</th>
                <th className={cell}>Engine read → person made it</th>
              </tr>
            </thead>
            <tbody>
              {corrections.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-gray-500">No corrections in this period.</td>
                </tr>
              )}
              {corrections.map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className={`${cell} whitespace-nowrap`}>
                    {formatDateTime(c.at)}
                    <div className="text-xs text-gray-500">{c.actor}</div>
                  </td>
                  <td className={`${cell} break-all`}>
                    {c.documentId ? (
                      <Link href={`/documents/${c.documentId}`} className="text-tmc underline">
                        {c.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${cell} text-xs text-gray-600`}>{c.kind === "word_upload" ? "Checked in Word" : c.kind === "edited" ? `Edited on screen${c.context ? `; ${c.context}` : ""}` : c.context}</td>
                  <td className={`${cell} font-mono text-xs`}>
                    {c.kind === "word_upload" ? (
                      c.after
                    ) : (
                      <>
                        <span className="bg-yellow-100">{c.before}</span> → <span className="bg-green-100">{c.after}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="font-semibold">Rejected drafts</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {rejections.length === 0 && <li className="text-gray-500">None in this period.</li>}
            {rejections.map((r) => (
              <li key={r.id}>
                <span className="text-gray-500">{formatDateTime(r.at)}</span> ·{" "}
                {r.documentId && (
                  <Link href={`/documents/${r.documentId}`} className="break-all text-tmc underline">
                    {r.name}
                  </Link>
                )}{" "}
                · {r.actor}
                <div className="text-gray-800">“{r.reason}”</div>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="font-semibold">Failed runs</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {failed.length === 0 && <li className="text-gray-500">None in this period.</li>}
            {failed.map((j) => (
              <li key={j.id}>
                <span className="text-gray-500">{formatDateTime(j.at)}</span> · {j.kind === "finalise" ? "Finalise" : j.file?.filename} ·{" "}
                {j.route.toUpperCase()} · {j.createdBy}
                <details className="text-xs">
                  <summary className="cursor-pointer text-tmc">Log</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2">{j.log?.slice(-3000)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
