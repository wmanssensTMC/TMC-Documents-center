import Link from "next/link";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listJobs } from "@/lib/jobs";
import { AutoRefresh } from "./auto-refresh";
import { JobsTable } from "./jobs-table";

export const metadata = { title: "Jobs · TMC Document Center" };

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const user = await requireUser();
  const sp = await searchParams;
  const rows = await listJobs(await getDb());
  const open = rows.some(({ job }) => job.state === "queued" || job.state === "running");

  return (
    <PageShell user={user}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-tmc">Neutralise jobs</h1>
        <Link href="/neutralise" className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white hover:bg-tmc/90">
          Neutralise documents
        </Link>
      </div>
      <Notice ok={sp.ok} error={sp.error} />
      {open && <AutoRefresh seconds={10} />}

      <JobsTable rows={rows} />
    </PageShell>
  );
}
