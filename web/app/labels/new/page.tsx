import Link from "next/link";
import { PageShell } from "@/components/app-header";
import { getRequestForPage } from "@/lib/api/requests";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listEntities } from "@/lib/entities";
import { finalCoas } from "@/lib/labels";
import { LabelForm, type LabelRequest } from "./label-form";

export const metadata = { title: "New label · TMC Document Center" };

export default async function NewLabelPage({ searchParams }: PageProps<"/labels/new">) {
  const user = await requireUser();
  const db = await getDb();
  const ready = (await listEntities(db)).map((e) => e.code);
  // "Make label" on a label request from TMC Logistics: ?request=<id>&line=<BC line no>
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const req = one(sp.request) ? await getRequestForPage(db, one(sp.request)!) : null;
  const open = req && req.kind === "label" && req.state !== "cancelled" ? req : null;
  const line = open?.lines.find((l) => String(l.lineNo) === one(sp.line));
  const request: LabelRequest | undefined = open
    ? { id: open.id, entity: open.entity, orderNo: open.orderNo, productName: line?.description ?? "" }
    : undefined;
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
      {open && (
        <p className="mt-3 rounded-md bg-tmc-light px-3 py-2 text-sm text-tmc">
          For the request from TMC Logistics: order {open.orderNo}, part {open.partNo}
          {line ? `, line ${line.lineNo}` : ""}.{" "}
          <Link href={`/api-jobs/${open.id}`} className="underline">
            Back to the request
          </Link>
        </p>
      )}
      <LabelForm entitiesWithDetails={ready} coas={await finalCoas(db)} request={request} />
    </PageShell>
  );
}
