import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { getDocument } from "@/lib/documents/service";
import { getStorage } from "@/lib/storage";
import { CheckForm } from "./check-form";

export const metadata = { title: "Check · TMC Document Center" };

export default async function CheckPage({ params }: PageProps<"/documents/[id]/check">) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const doc = await getDocument(db, id);
  if (!doc) notFound();
  if (doc.status !== "To check") redirect(`/documents/${doc.id}`);

  const [lastFinalise] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.documentId, doc.id), eq(jobs.kind, "finalise")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  const busy = lastFinalise && (lastFinalise.state === "queued" || lastFinalise.state === "running");
  const file = (kind: string) => `/api/files/${doc.id}/${kind}?inline=1`;
  const parts = doc.yellowParts ?? [];

  return (
    <PageShell user={user}>
      <Link href={`/documents/${doc.id}`} className="text-sm text-tmc underline">
        ← Document
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-tmc">Check: {doc.name}</h1>
      <p className="text-sm text-gray-600">
        {parts.length
          ? `${parts.length} yellow part(s) to confirm. Nothing becomes Final until every one is confirmed by you.`
          : doc.type === "LABEL"
            ? "Check the label and approve, or reject. A label made with the SAMPLE template can never become Final."
            : "The neutralizer marked nothing yellow. Compare with the original and approve, or reject."}
      </p>

      {busy && (
        <>
          <p className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-900 ring-1 ring-blue-200">
            Being finalised by the neutralizer… This page updates itself.
          </p>
          <AutoRefresh seconds={10} />
        </>
      )}
      {lastFinalise?.state === "failed" && (
        <details className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200">
          <summary className="cursor-pointer">The last finalise attempt did not work. Show why</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{lastFinalise.log?.slice(-4000)}</pre>
        </details>
      )}

      {/* Screen-by-screen: supplier original left, TMC draft right (Willem 16/10). */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-1 text-sm font-semibold text-gray-700">Supplier original</h2>
          {doc.sourceKey ? (
            <iframe src={file("source")} title="Supplier original" className="h-[70vh] w-full rounded border bg-white" />
          ) : (
            <p className="rounded border bg-white p-4 text-sm text-gray-600">
              {doc.type === "LABEL" ? "No original: a label is made from the values typed in the form." : "No original stored."}
            </p>
          )}
        </section>
        <section>
          <h2 className="mb-1 text-sm font-semibold text-gray-700">TMC draft</h2>
          {doc.previewKey || doc.pdfKey ? (
            <iframe
              src={file(doc.previewKey ? "preview" : "pdf")}
              title="TMC draft"
              className="h-[70vh] w-full rounded border bg-white"
            />
          ) : (
            <p className="rounded border bg-white p-4 text-sm text-gray-600">
              No preview available. Download the Word file to see the draft.
            </p>
          )}
          {doc.docxKey && (
            <a href={`/api/files/${doc.id}/docx`} className="mt-1 inline-block text-sm text-tmc underline">
              Download the Word draft
            </a>
          )}
        </section>
      </div>

      <CheckForm
        documentId={doc.id}
        parts={parts}
        hasPdf={!!doc.pdfKey && parts.length === 0}
        busy={!!busy}
        uploadMode={getStorage().mode}
        initial={{ productName: doc.productName ?? "", fileNr: doc.fileNr ?? "", batch: doc.batch ?? "" }}
        naming={{ type: doc.type, entity: doc.entity, batchLocked: !!doc.batch, language: doc.language, currentName: doc.name }}
      />
    </PageShell>
  );
}
