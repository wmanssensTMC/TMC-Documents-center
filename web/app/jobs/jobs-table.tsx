// The list of neutralise jobs: under the Neutralise form (Willem 22/10: Jobs folded into
// Neutralise) and on the full Jobs page.
import Link from "next/link";
import type { JobState } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { listJobs } from "@/lib/jobs";

const STATE: Record<JobState, { label: string; className: string }> = {
  queued: { label: "Waiting for the neutralizer", className: "text-gray-700" },
  running: { label: "Running", className: "text-blue-700" },
  to_check: { label: "Ready to check", className: "text-amber-700" },
  done: { label: "Done", className: "text-green-700" },
  failed: { label: "Failed", className: "text-red-700" },
};

export function JobsTable({ rows }: { rows: Awaited<ReturnType<typeof listJobs>> }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
      <table className="w-full min-w-[800px] text-left text-sm">
        <thead className="bg-tmc-light text-tmc">
          <tr>
            <th className="px-3 py-2">Sent</th>
            <th className="px-3 py-2">Supplier document</th>
            <th className="px-3 py-2">Type / entity</th>
            <th className="px-3 py-2">Typed values</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                No jobs yet.
              </td>
            </tr>
          )}
          {rows.map(({ job, documents }) => (
            <tr key={job.id} className="border-t border-gray-100 align-top">
              <td className="px-3 py-2 whitespace-nowrap">
                {formatDateTime(job.createdAt)}
                <div className="text-xs text-gray-500">{job.createdBy}</div>
              </td>
              <td className="px-3 py-2 break-all">
                {job.supplierFile?.filename ?? "Finalise"}
                {job.commercialFiles.length > 0 && (
                  <div className="text-xs text-gray-500">+ {job.commercialFiles.map((f) => f.filename).join(", ")}</div>
                )}
              </td>
              <td className="px-3 py-2">
                {job.route.toUpperCase()} · {job.entity}
              </td>
              <td className="px-3 py-2 text-xs">
                {[job.productName, job.fileNr, job.batch].filter(Boolean).join(" · ") || "—"}
              </td>
              <td className={`px-3 py-2 font-medium ${STATE[job.state].className}`}>
                {STATE[job.state].label}
                {job.state === "to_check" && job.log?.includes("HELD BACK") && (
                  <span className="mt-1 block text-xs font-normal text-amber-700">Some batches got no document: see the log</span>
                )}
                {(job.state === "failed" || job.state === "to_check") && job.log && (
                  <details className="mt-1 text-xs font-normal text-gray-700">
                    <summary className="cursor-pointer">Show log</summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2">{job.log.slice(-4000)}</pre>
                  </details>
                )}
              </td>
              <td className="px-3 py-2">
                {documents.map((d) => (
                  <Link key={d.id} href={d.status === "To check" ? `/documents/${d.id}/check` : `/documents/${d.id}`} className="block break-all text-tmc underline">
                    {d.name}
                    <span className="ml-1 text-xs text-gray-500">({d.status})</span>
                  </Link>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
