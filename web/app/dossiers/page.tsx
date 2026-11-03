// Dossier overview (Willem 02/11): all supplier documents sent, drafts and Finals of one TMC file nr.
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { JobsTable } from "@/app/jobs/jobs-table";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dossierFileNr, getDossierDocuments } from "@/lib/documents/dossier";
import { formatDateTime } from "@/lib/format";
import { listJobs } from "@/lib/jobs";

export const metadata = { title: "Dossier · TMC Document Center" };

const STATUS_CLASS: Record<string, string> = {
  "To check": "text-amber-700",
  Final: "text-green-700",
  Rejected: "text-red-700",
  Superseded: "text-gray-500",
};

export default async function DossierPage({ searchParams }: PageProps<"/dossiers">) {
  const user = await requireUser();
  // `?nr=` is decoded once by the platform: "50%25" stays "50%25" (review L2)
  const fileNr = dossierFileNr((await searchParams).nr);
  if (!fileNr) notFound();
  const db = await getDb();
  const [rows, docs] = await Promise.all([listJobs(db, 100, { fileNr }), getDossierDocuments(db, fileNr)]);
  const open = rows.some(({ job }) => job.state === "queued" || job.state === "running");
  const waiting = docs.filter((d) => d.status === "To check").length;

  return (
    <PageShell user={user}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-tmc">Dossier {fileNr}</h1>
          <p className="text-sm text-gray-600">
            {rows.length} supplier document(s) sent · {docs.length} document(s) · {waiting} waiting for a check
          </p>
        </div>
        <Link href="/neutralise" className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white hover:bg-tmc/90">
          Neutralise documents
        </Link>
      </div>
      {open && <AutoRefresh seconds={10} />}

      <h2 className="mt-6 font-semibold text-gray-800">Documents</h2>
      <div className="mt-2 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="bg-tmc-light text-tmc">
            <tr>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Batch</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Yellow parts</th>
              <th className="px-3 py-2">Made</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  No documents for this dossier yet.
                </td>
              </tr>
            )}
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2 break-all">
                  <Link href={d.status === "To check" ? `/documents/${d.id}/check` : `/documents/${d.id}`} className="text-tmc underline">
                    {d.name}
                  </Link>
                </td>
                <td className="px-3 py-2">{d.type}</td>
                <td className="px-3 py-2">{d.batch ?? "—"}</td>
                <td className={`px-3 py-2 font-medium ${STATUS_CLASS[d.status] ?? ""}`}>
                  {d.status}
                  {d.version ? ` · version ${d.version}` : ""}
                </td>
                <td className="px-3 py-2">{d.status === "To check" ? d.yellowCount : "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6 font-semibold text-gray-800">Supplier documents sent to the neutralizer</h2>
      <JobsTable rows={rows} />
    </PageShell>
  );
}
