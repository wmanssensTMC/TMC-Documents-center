import Link from "next/link";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { DOC_TYPES, ENTITIES, STATUSES, type DocStatus, type DocType, type Entity } from "@/lib/db/schema";
import { listDocuments, PAGE_SIZE, type DocumentFilters } from "@/lib/documents/service";
import { formatDateTime, formatDay } from "@/lib/format";

export const metadata = { title: "Library · TMC Document Center" };

type SP = Record<string, string | string[] | undefined>;

function one(sp: SP, key: string, max = 100) {
  const v = sp[key];
  const s = (Array.isArray(v) ? v[0] : v)?.trim().slice(0, max);
  return s || undefined;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

const cell = "px-3 py-2";
const filterInput = "mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs font-normal text-gray-900";

export default async function LibraryPage({ searchParams }: PageProps<"/">) {
  const user = await requireUser();
  const sp = (await searchParams) as SP;

  const filters: DocumentFilters = {
    q: one(sp, "q", 200),
    type: pick<DocType>(one(sp, "type"), DOC_TYPES),
    entity: pick<Entity>(one(sp, "entity"), ENTITIES),
    status: pick<DocStatus | "all">(one(sp, "status"), [...STATUSES, "all"]),
    product: one(sp, "product"),
    batch: one(sp, "batch"),
    fileNr: one(sp, "fileNr"),
  };
  const page = Math.max(0, Math.min(1000, Number(one(sp, "page")) || 0));
  const rows = await listDocuments(await getDb(), filters, page);
  const hasMore = rows.length > PAGE_SIZE;
  const shown = rows.slice(0, PAGE_SIZE);
  const qs = (p: number) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
    if (p) params.set("page", String(p));
    return `/?${params}`;
  };

  return (
    <PageShell user={user}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-tmc">Library</h1>
        <Link href="/upload" className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white hover:bg-tmc/90">
          Upload document
        </Link>
      </div>
      <Notice ok={sp.ok} error={sp.error} />

      <form method="get" action="/" className="mt-4">
        <div className="flex gap-2">
          <input
            name="q"
            type="search"
            defaultValue={filters.q}
            placeholder="Search product, batch, dossier, INCI, CAS, supplier…"
            maxLength={200}
            className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc"
          />
          <button type="submit" className="rounded-md bg-tmc px-4 py-2 text-sm font-medium text-white">
            Search
          </button>
          <Link href="/" className="self-center text-sm text-tmc underline">
            Clear
          </Link>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-tmc-light align-top text-tmc">
              <tr>
                <th className={cell}>
                  Type
                  <select name="type" defaultValue={filters.type ?? ""} className={filterInput} aria-label="Filter on type">
                    <option value="">All</option>
                    {DOC_TYPES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </th>
                <th className={cell}>
                  Product / file name
                  <input name="product" defaultValue={filters.product} className={filterInput} aria-label="Filter on product" />
                </th>
                <th className={cell}>
                  Batch
                  <input name="batch" defaultValue={filters.batch} className={filterInput} aria-label="Filter on batch" />
                </th>
                <th className={cell}>
                  Dossier
                  <input name="fileNr" defaultValue={filters.fileNr} className={filterInput} aria-label="Filter on dossier" />
                </th>
                <th className={cell}>
                  Entity
                  <select name="entity" defaultValue={filters.entity ?? ""} className={filterInput} aria-label="Filter on entity">
                    <option value="">All</option>
                    {ENTITIES.map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </th>
                <th className={cell}>
                  Status
                  <select name="status" defaultValue={filters.status ?? ""} className={filterInput} aria-label="Filter on status">
                    <option value="">Current</option>
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                    <option value="all">All versions</option>
                  </select>
                </th>
                <th className={cell}>
                  Added
                  <button type="submit" className="mt-1 block rounded bg-tmc px-2 py-1 text-xs font-medium text-white">
                    Filter
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
                    No documents found.
                  </td>
                </tr>
              )}
              {shown.map((d) => (
                <tr key={d.id} className="relative border-t border-gray-100 hover:bg-tmc-light/50">
                  <td className={cell}>
                    <span className="rounded bg-tmc-light px-1.5 py-0.5 text-xs font-semibold text-tmc">{d.type}</span>
                  </td>
                  <td className={cell}>
                    <Link href={`/documents/${d.id}`} className="font-medium text-gray-900 after:absolute after:inset-0">
                      {d.productName ?? <span className="italic text-gray-500">product to confirm</span>}
                    </Link>
                    <div className="text-xs text-gray-500">
                      {d.name}
                      {(d.version ?? 0) > 1 && ` · v${d.version}`}
                    </div>
                  </td>
                  <td className={cell}>{d.batch}</td>
                  <td className={cell}>{d.fileNr}</td>
                  <td className={cell}>{d.entity}</td>
                  <td className={cell}>
                    <span className={d.status === "Final" ? "text-green-700" : d.status === "Superseded" ? "text-gray-500" : "text-amber-700"}>
                      {d.status}
                    </span>
                  </td>
                  <td className={cell} title={formatDateTime(d.createdAt)}>
                    {formatDay(d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>

      <div className="mt-3 flex justify-between text-sm">
        {page > 0 ? (
          <Link href={qs(page - 1)} className="text-tmc underline">
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {hasMore && (
          <Link href={qs(page + 1)} className="text-tmc underline">
            Older →
          </Link>
        )}
      </div>
    </PageShell>
  );
}
