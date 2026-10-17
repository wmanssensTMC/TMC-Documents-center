import { PageShell } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listEntities } from "@/lib/entities";
import { getStorage } from "@/lib/storage";
import { NeutraliseForm } from "./neutralise-form";

export const metadata = { title: "Neutralise · TMC Document Center" };

export default async function NeutralisePage() {
  const user = await requireUser();
  const ready = (await listEntities(await getDb())).map((e) => e.code);
  return (
    <PageShell user={user}>
      <h1 className="text-xl font-semibold text-tmc">Neutralise supplier documents</h1>
      <p className="mt-1 text-sm text-gray-600">
        Drop supplier COAs, MSDSs, TDSs or spec sheets. The neutralizer makes the TMC version as a Word draft; anything
        uncertain is marked yellow for you to check. Values you type here replace what the supplier document says.
      </p>
      <p className="mt-1 text-sm font-medium text-amber-800">Test documents only, until the pilot is approved for real documents.</p>
      <NeutraliseForm uploadMode={getStorage().mode} entitiesWithDetails={ready} />
    </PageShell>
  );
}
