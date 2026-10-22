import { PageShell } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listEntities } from "@/lib/entities";
import { listJobs } from "@/lib/jobs";
import { getStorage } from "@/lib/storage";
import Link from "next/link";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { JobsTable } from "@/app/jobs/jobs-table";
import { NeutraliseForm } from "./neutralise-form";

export const metadata = { title: "Neutralise · TMC Document Center" };

export default async function NeutralisePage() {
  const user = await requireUser();
  const db = await getDb();
  const ready = (await listEntities(db)).map((e) => e.code);
  // Jobs folded into Neutralise (Willem 22/10): what you sent and how far it is, right here
  const rows = await listJobs(db, 15);
  const open = rows.some(({ job }) => job.state === "queued" || job.state === "running");
  return (
    <PageShell user={user}>
      <h1 className="text-xl font-semibold text-tmc">Neutralise supplier documents</h1>
      <p className="mt-1 text-sm text-gray-600">
        Drop supplier COAs, MSDSs, TDSs or spec sheets. The neutralizer makes the TMC version as a Word draft; anything
        uncertain is marked yellow for you to check. Values you type here replace what the supplier document says.
      </p>
      <p className="mt-1 text-sm font-medium text-amber-800">Test documents only, until the pilot is approved for real documents.</p>
      <NeutraliseForm uploadMode={getStorage().mode} entitiesWithDetails={ready} />

      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-tmc">Sent to the neutralizer</h2>
        <Link href="/jobs" className="text-sm text-tmc underline">
          All jobs
        </Link>
      </div>
      {open && <AutoRefresh seconds={10} />}
      <JobsTable rows={rows} />
    </PageShell>
  );
}
