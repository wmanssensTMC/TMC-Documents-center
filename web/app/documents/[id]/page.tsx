import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getAuditTrail, getDocument, getVersions } from "@/lib/documents/service";
import { formatDate, formatDateTime } from "@/lib/format";

export const metadata = { title: "Document · TMC Document Center" };

const ACTIONS: Record<string, string> = {
  "document.created": "Added",
  "document.superseded": "Replaced by a newer version",
  "document.downloaded": "Downloaded",
  "document.viewed": "Viewed",
};

function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="break-words text-gray-900">{value}</dd>
    </div>
  );
}

function Download({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light">
      {label}
    </a>
  );
}

export default async function DocumentPage({ params, searchParams }: PageProps<"/documents/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const doc = await getDocument(db, id);
  if (!doc) notFound();

  const versions = await getVersions(db, doc.name);
  const trail = await getAuditTrail(
    db,
    versions.map((v) => v.id),
  );
  const file = (kind: string, inline = false) => `/api/files/${doc.id}/${kind}${inline ? "?inline=1" : ""}`;
  const sourceIsPdf = doc.sourceFilename?.toLowerCase().endsWith(".pdf");

  return (
    <PageShell user={user}>
      <Link href="/" className="text-sm text-tmc underline">
        ← Library
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-tmc">{doc.productName}</h1>
          <p className="break-all text-sm text-gray-600">
            {doc.name} · version {doc.version} ·{" "}
            <span className={doc.status === "Final" ? "text-green-700" : "text-gray-500"}>{doc.status}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Download href={file("pdf")} label="Download PDF" />
          {doc.docxKey && <Download href={file("docx")} label="Download Word" />}
          {doc.sourceKey && <Download href={file("source")} label="Supplier original" />}
        </div>
      </div>
      <Notice ok={sp.ok} error={sp.error} />
      {doc.status === "Superseded" && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          This is an old version. The current version is in the list below.
        </p>
      )}

      {/* Screen-by-screen: supplier original left, TMC document right (Willem 16/10). */}
      <div className={`mt-4 grid gap-4 ${doc.sourceKey ? "lg:grid-cols-2" : ""}`}>
        {doc.sourceKey && (
          <section>
            <h2 className="mb-1 text-sm font-semibold text-gray-700">Supplier original</h2>
            {sourceIsPdf ? (
              <iframe src={file("source", true)} title="Supplier original" className="h-[70vh] w-full rounded border bg-white" />
            ) : (
              <p className="rounded border bg-white p-4 text-sm text-gray-600">No preview for this file type. Use the download button.</p>
            )}
          </section>
        )}
        <section>
          <h2 className="mb-1 text-sm font-semibold text-gray-700">TMC document</h2>
          <iframe src={file("pdf", true)} title="TMC document" className="h-[70vh] w-full rounded border bg-white" />
          <a href={file("pdf", true)} target="_blank" rel="noopener" className="mt-1 inline-block text-sm text-tmc underline">
            Open PDF in a new tab
          </a>
        </section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold">Details</h2>
          <dl>
            <Field label="Type" value={doc.type} />
            <Field label="Entity" value={doc.entity} />
            <Field label="Product" value={doc.productName} />
            <Field label="INCI name" value={doc.inciName} />
            <Field label="CAS number" value={doc.casNumber} />
            <Field label="Batch" value={doc.batch} />
            <Field label="Dossier" value={doc.fileNr} />
            <Field label="PO number" value={doc.poNumber} />
            <Field label="Language" value={doc.language} />
            <Field label="Manufactured" value={formatDate(doc.manufacturingDate)} />
            <Field label="Expiry / retest" value={formatDate(doc.expiryOrRetestDate)} />
            <Field label="Supplier (internal)" value={doc.supplierName} />
            <Field label="Tags" value={doc.tags.join(", ")} />
            <Field label="Added by" value={`${doc.createdBy}, ${formatDateTime(doc.createdAt)}`} />
            <Field label="Approved by" value={doc.approvedBy ? `${doc.approvedBy}, ${formatDateTime(doc.approvedAt)}` : null} />
          </dl>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold">Versions</h2>
          <ul className="space-y-1 text-sm">
            {versions.map((v) => (
              <li key={v.id}>
                <Link href={`/documents/${v.id}`} className={v.id === doc.id ? "font-semibold" : "text-tmc underline"}>
                  Version {v.version}
                </Link>{" "}
                · {v.status} · {formatDateTime(v.createdAt)}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold">History</h2>
          <ul className="space-y-1 text-sm">
            {trail.map((a) => (
              <li key={a.id}>
                <span className="text-gray-500">{formatDateTime(a.at)}</span> · {ACTIONS[a.action] ?? a.action}
                {typeof a.details?.file === "string" && ` (${a.details.file})`}
                {typeof a.details?.version === "number" && ` v${a.details.version}`} · {a.actor}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
