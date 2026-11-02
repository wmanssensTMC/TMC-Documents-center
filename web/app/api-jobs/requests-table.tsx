// Requests from TMC Logistics (API v1): on the Neutralise page and the full Requests page.
import Link from "next/link";
import type { RequestRow } from "@/lib/api/requests";
import type { ApiJobKind, ApiJobState } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";

export const REQUEST_STATE: Record<ApiJobState, { label: string; className: string }> = {
  "waiting-input": { label: "Waiting for you", className: "text-amber-700" },
  "in-progress": { label: "Neutralizer running", className: "text-blue-700" },
  "to-check": { label: "To check", className: "text-amber-700" },
  ready: { label: "Ready (Final)", className: "text-green-700" },
  failed: { label: "Failed", className: "text-red-700" },
  cancelled: { label: "Cancelled (not needed)", className: "text-gray-500" },
};

export const REQUEST_KIND: Record<ApiJobKind, string> = {
  "coa-neutralise": "COA",
  "sds-neutralise": "MSDS / SDS",
  "tds-neutralise": "TDS",
  label: "Label",
};

export function RequestsTable({ rows }: { rows: RequestRow[] }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-tmc-light text-tmc">
          <tr>
            <th className="px-3 py-2">Received</th>
            <th className="px-3 py-2">Order / part</th>
            <th className="px-3 py-2">Document</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                No requests.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-100 align-top">
              <td className="px-3 py-2 whitespace-nowrap">
                {formatDateTime(r.createdAt)}
                <div className="text-xs text-gray-500">{r.requestedBy}</div>
              </td>
              <td className="px-3 py-2">
                <Link href={`/api-jobs/${r.id}`} className="font-medium text-tmc underline">
                  {r.orderNo} · part {r.partNo}
                </Link>
              </td>
              <td className="px-3 py-2">{REQUEST_KIND[r.kind]}</td>
              <td className={`px-3 py-2 font-medium ${REQUEST_STATE[r.state].className}`}>
                {REQUEST_STATE[r.state].label}
                {r.problem && <div className="text-xs font-normal text-gray-600">{r.problem}</div>}
              </td>
              <td className="px-3 py-2">
                {r.documents.map((d) => (
                  <Link key={d.id} href={d.status === "To check" ? `/documents/${d.id}/check` : `/documents/${d.id}`} className="block break-all text-tmc underline">
                    {d.name} <span className="text-xs text-gray-500">({d.status})</span>
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
