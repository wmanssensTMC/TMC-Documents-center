// One request from TMC Logistics (API v1). This is the page the API's `link` opens. A person adds
// the supplier document here (supplier name mandatory as always) or makes the label per BC line.
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { JobsTable } from "@/app/jobs/jobs-table";
import { NeutraliseForm } from "@/app/neutralise/neutralise-form";
import { getRequestForPage } from "@/lib/api/requests";
import { requireUser } from "@/lib/auth";
import { API_KIND_ROUTE } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { listEntities } from "@/lib/entities";
import { formatDateTime } from "@/lib/format";
import { listJobs } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";
import { REQUEST_KIND, REQUEST_STATE } from "../requests-table";

export const metadata = { title: "Request · TMC Document Center" };

export default async function RequestPage({ params, searchParams }: PageProps<"/api-jobs/[id]">) {
  const user = await requireUser();
  const db = await getDb();
  const req = await getRequestForPage(db, (await params).id);
  if (!req) notFound();
  const sp = await searchParams;
  const runs = await listJobs(db, 100, { apiJobId: req.id });
  const route = API_KIND_ROUTE[req.kind];
  const cancelled = req.state === "cancelled";
  const running = req.state === "in-progress";

  return (
    <PageShell user={user}>
      <p className="text-sm">
        <Link href="/api-jobs" className="text-tmc underline">
          All requests
        </Link>
      </p>
      <h1 className="mt-2 text-xl font-semibold text-tmc">
        {REQUEST_KIND[req.kind]} for order {req.orderNo}, part {req.partNo}
      </h1>
      <Notice ok={sp.ok} error={sp.error} />
      {running && <AutoRefresh seconds={10} />}

      <dl className="mt-4 grid gap-3 rounded-lg bg-white p-4 text-sm shadow-sm ring-1 ring-black/5 sm:grid-cols-4">
        <div>
          <dt className="text-gray-500">State</dt>
          <dd className={`font-medium ${REQUEST_STATE[req.state].className}`}>{REQUEST_STATE[req.state].label}</dd>
          {req.problem && <dd className="text-xs text-gray-600">{req.problem}</dd>}
        </div>
        <div>
          <dt className="text-gray-500">Asked by</dt>
          <dd className="break-all">{req.requestedBy}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Received</dt>
          <dd>{formatDateTime(req.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Entity</dt>
          <dd>{req.entity}</dd>
        </div>
      </dl>
      {cancelled && (
        <p className="mt-3 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-700">
          Cancelled in TMC Logistics on {formatDateTime(req.cancelledAt)}: not needed any more. Drafts waiting for a check were
          rejected; Final documents stay in the library.
        </p>
      )}

      <section className="mt-6 rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">BC lines of this part</h2>
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-gray-600">
            <tr>
              <th className="py-1 pr-2">Line</th>
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2">Description</th>
              {req.kind === "label" && !cancelled && <th />}
            </tr>
          </thead>
          <tbody>
            {req.lines.map((l) => (
              <tr key={l.lineNo} className="border-t border-gray-100">
                <td className="py-1.5 pr-2">{l.lineNo}</td>
                <td className="py-1.5 pr-2">{l.itemNo ?? "—"}</td>
                <td className="py-1.5 pr-2">{l.description ?? "—"}</td>
                {req.kind === "label" && !cancelled && (
                  <td className="py-1.5">
                    <Link href={`/labels/new?request=${req.id}&line=${l.lineNo}`} className="text-tmc underline">
                      Make label
                    </Link>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {route && !cancelled && (
        <>
          <h2 className="mt-8 text-lg font-semibold text-tmc">Add supplier document</h2>
          <p className="mt-1 text-sm text-gray-600">
            The dossier is the order number and the product name is the BC description; both are proposals you may change.
            Type the supplier name: it is internal and never printed.
          </p>
          <NeutraliseForm
            uploadMode={getStorage().mode}
            entitiesWithDetails={(await listEntities(db)).map((e) => e.code)}
            request={{ id: req.id, route, entity: req.entity, orderNo: req.orderNo, lines: req.lines }}
          />
        </>
      )}

      <h2 className="mt-10 text-lg font-semibold text-tmc">Runs for this request</h2>
      <JobsTable rows={runs} />
    </PageShell>
  );
}
