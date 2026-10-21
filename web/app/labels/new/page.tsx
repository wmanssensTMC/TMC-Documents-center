import { PageShell } from "@/components/app-header";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listEntities } from "@/lib/entities";
import { finalCoas } from "@/lib/labels";
import { LabelForm } from "./label-form";

export const metadata = { title: "New label · TMC Document Center" };

export default async function NewLabelPage() {
  const user = await requireUser();
  const db = await getDb();
  const ready = (await listEntities(db)).map((e) => e.code);
  return (
    <PageShell user={user}>
      <h1 className="text-xl font-semibold text-tmc">New label</h1>
      <p className="mt-1 text-sm text-gray-600">
        Choose a template, fill in the label and send it. The worker makes the Word and PDF; the label then waits in the
        library for approval, like any other document. One label per language.
      </p>
      <p className="mt-1 text-sm font-medium text-amber-800">
        Only the SAMPLE template exists until Kars&apos; real template arrives. Sample labels can never become Final.
      </p>
      <LabelForm entitiesWithDetails={ready} coas={await finalCoas(db)} />
    </PageShell>
  );
}
