"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { DropZone } from "@/components/drop-zone";
import { sendFile } from "@/lib/client-upload";
import { ENTITIES, type Entity, type Route } from "@/lib/constants";
import { MAX_FILE_BYTES } from "@/lib/files";
import { submitJobs } from "./actions";

const ROUTE_LABEL: Record<Route, string> = {
  auto: "Recognise from the title",
  coa: "COA (certificate of analysis)",
  sds: "MSDS / SDS",
  tds: "TDS or specification sheet",
};

type Row = { file: File; productName: string; fileNr: string; batch: string };

const input =
  "block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";
const noSubscribe = () => () => {};

function pdfsOnly(list: FileList | File[] | null): { ok: File[]; error?: string } {
  const files = Array.from(list ?? []);
  const bad = files.find((f) => !/\.pdf$/i.test(f.name) || f.size > MAX_FILE_BYTES);
  return bad ? { ok: [], error: `${bad.name}: only PDF files up to 25 MB.` } : { ok: files };
}

export function NeutraliseForm({ uploadMode, entitiesWithDetails }: { uploadMode: "blob" | "local"; entitiesWithDetails: string[] }) {
  const router = useRouter();
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [route, setRoute] = useState<Route>("auto");
  const [entity, setEntity] = useState<Entity>("TMC");
  const [rows, setRows] = useState<Row[]>([]);
  const [commercial, setCommercial] = useState<File[]>([]);
  const [supplierName, setSupplierName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const withCommercial = route === "auto" || route === "coa";
  const showBatch = route === "auto" || route === "coa";

  function addSupplierFiles(list: FileList | File[] | null) {
    const { ok, error } = pdfsOnly(list);
    if (error) return setError(error);
    setError(null);
    setRows((r) => [...r, ...ok.map((file) => ({ file, productName: "", fileNr: "", batch: "" }))].slice(0, 20));
  }

  function update(i: number, patch: Partial<Row>) {
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  }

  function useFirstForAll() {
    setRows((r) => r.map((row) => ({ ...row, productName: r[0].productName, fileNr: r[0].fileNr })));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!rows.length) return setError("Add at least one supplier document.");
    if (!entitiesWithDetails.includes(entity)) return setError(`No details entered yet for ${entity}.`);
    try {
      const commercialRefs = [];
      if (withCommercial) {
        for (const f of commercial) {
          setBusy(`Uploading ${f.name}…`);
          commercialRefs.push({ key: await sendFile(uploadMode, "input", f), filename: f.name });
        }
      }
      const jobs = [];
      for (const row of rows) {
        setBusy(`Uploading ${row.file.name}…`);
        jobs.push({
          route,
          entity,
          productName: row.productName,
          fileNr: row.fileNr,
          batch: showBatch ? row.batch : "",
          supplierName,
          supplierFile: { key: await sendFile(uploadMode, "input", row.file), filename: row.file.name },
          commercialFiles: commercialRefs,
        });
      }
      setBusy("Sending to the neutralizer…");
      const result = await submitJobs(jobs);
      if (!result.ok) {
        setBusy(null);
        return setError(result.error);
      }
      router.push(`/jobs?ok=${encodeURIComponent(`${result.count} document(s) sent to the neutralizer.`)}`);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed.");
    }
  }

  return (
    <form onSubmit={onSubmit} method="post" action="/neutralise" className="mt-6 space-y-6">
      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5 sm:grid-cols-3">
        <label className="block text-sm">
          Document type
          <select value={route} onChange={(e) => setRoute(e.target.value as Route)} className={`mt-1 ${input}`}>
            {(Object.keys(ROUTE_LABEL) as Route[]).map((r) => (
              <option key={r} value={r}>
                {ROUTE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Entity
          <select value={entity} onChange={(e) => setEntity(e.target.value as Entity)} className={`mt-1 ${input}`}>
            {ENTITIES.map((x) => (
              <option key={x} value={x} disabled={!entitiesWithDetails.includes(x)}>
                {x}
                {!entitiesWithDetails.includes(x) && " (no details yet)"}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Supplier name (internal, optional)
          <input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} maxLength={200} className={`mt-1 ${input}`} />
        </label>
      </section>

      <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Supplier documents (PDF)</h2>
          {rows.length > 1 && (
            <button type="button" onClick={useFirstForAll} className="text-sm text-tmc underline">
              Use first row&apos;s product and dossier for all
            </button>
          )}
        </div>
        <div className="mt-3">
          <DropZone label="Add supplier documents" accept=".pdf,application/pdf" multiple onFiles={addSupplierFiles} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          One type per drop; several COAs at once is fine. Leave a field empty to let the neutralizer read it from the document.
        </p>
        {rows.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-gray-600">
                <tr>
                  <th className="py-1 pr-2">File</th>
                  <th className="py-1 pr-2">Product name (TMC)</th>
                  <th className="py-1 pr-2">Dossier</th>
                  {showBatch && <th className="py-1 pr-2">Batch</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="max-w-[14rem] truncate py-1.5 pr-2" title={row.file.name}>
                      {row.file.name}
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={row.productName} onChange={(e) => update(i, { productName: e.target.value })} maxLength={200} className={input} aria-label={`Product for ${row.file.name}`} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input value={row.fileNr} onChange={(e) => update(i, { fileNr: e.target.value })} maxLength={50} placeholder="840.S0850" className={input} aria-label={`Dossier for ${row.file.name}`} />
                    </td>
                    {showBatch && (
                      <td className="py-1.5 pr-2">
                        <input value={row.batch} onChange={(e) => update(i, { batch: e.target.value })} maxLength={100} className={input} aria-label={`Batch for ${row.file.name}`} />
                      </td>
                    )}
                    <td>
                      <button type="button" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} className="text-sm text-red-700 underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {withCommercial && (
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
          <h2 className="font-semibold">Commercial documents for the COAs (optional)</h2>
          <p className="mt-1 text-xs text-gray-500">
            PFI, order confirmation, contract or invoice. The neutralizer takes the product name and dossier from them;
            values typed above win.
          </p>
          <div className="mt-3">
            <DropZone
              label="Add commercial documents"
              accept=".pdf,application/pdf"
              multiple
              onFiles={(files) => {
                const { ok, error } = pdfsOnly(files);
                if (error) setError(error);
                else setCommercial(ok.slice(0, 5));
              }}
            />
          </div>
          {commercial.length > 0 && <p className="mt-1 text-xs text-gray-600">{commercial.map((f) => f.name).join(", ")}</p>}
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!ready || !!busy}
        className="w-full rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-60 sm:w-auto"
      >
        {busy ?? (ready ? `Send ${rows.length || ""} to the neutralizer` : "Loading…")}
      </button>
    </form>
  );
}
