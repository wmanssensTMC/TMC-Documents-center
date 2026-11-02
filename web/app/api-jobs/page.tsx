import { PageShell } from "@/components/app-header";
import { listRequests } from "@/lib/api/requests";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { RequestsTable } from "./requests-table";

export const metadata = { title: "Requests · TMC Document Center" };

export default async function RequestsPage() {
  const user = await requireUser();
  const rows = await listRequests(await getDb(), { limit: 200 });
  return (
    <PageShell user={user}>
      <h1 className="text-xl font-semibold text-tmc">Requests from TMC Logistics</h1>
      <p className="mt-1 text-sm text-gray-600">
        A coordinator asked for these documents in TMC Logistics. Open a request to add the supplier document or make the
        label; the check and Final happen here as usual. TMC Logistics only sees the state and the document names.
      </p>
      <RequestsTable rows={rows} />
    </PageShell>
  );
}
