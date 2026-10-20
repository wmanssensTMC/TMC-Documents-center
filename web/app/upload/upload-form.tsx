"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ENTITIES } from "@/lib/constants";
import { DropZone } from "@/components/drop-zone";
import { sendFile } from "@/lib/client-upload";
import { MAX_FILE_BYTES, type FileKind } from "@/lib/files";
import { fileStem, NAMED_TYPES } from "@/lib/naming";
import { saveDocument } from "./actions";

type NamedType = (typeof NAMED_TYPES)[number];
const TYPE_LABEL: Record<NamedType, string> = {
  COA: "COA (certificate of analysis)",
  MSDS: "MSDS / SDS (safety data sheet)",
  TDS: "TDS (technical data sheet)",
  SPEC: "Specification sheet",
};

const SLOTS: { kind: FileKind; label: string; accept: string; required: boolean; help: string }[] = [
  { kind: "pdf", label: "TMC document (PDF)", accept: ".pdf,application/pdf", required: true, help: "Required." },
  {
    kind: "docx",
    label: "TMC document (Word)",
    accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    required: false,
    help: "Optional.",
  },
  {
    kind: "source",
    label: "Supplier original",
    accept: ".pdf,.docx,.png,.jpg,.jpeg",
    required: false,
    help: "Optional. Visible to all logged-in users, never on TMC output.",
  },
];

const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";

const noSubscribe = () => () => {};

export function UploadForm({ uploadMode }: { uploadMode: "blob" | "local" }) {
  const router = useRouter();
  const [type, setType] = useState<NamedType>("COA");
  const [entity, setEntity] = useState<(typeof ENTITIES)[number]>("TMC");
  const [productName, setProductName] = useState("");
  const [fileNr, setFileNr] = useState("");
  const [batch, setBatch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Until the page script runs, the button stays disabled: a plain browser submit would skip the upload.
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);

  const name = productName.trim() ? fileStem({ type, entity, productName, fileNr, batch }) : "";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const files: Partial<Record<FileKind, File>> = {};
    for (const slot of SLOTS) {
      const f = form.get(slot.kind);
      if (f instanceof File && f.size > 0) {
        if (f.size > MAX_FILE_BYTES) return setError(`${slot.label}: file is larger than 25 MB.`);
        files[slot.kind] = f;
      }
    }
    if (!files.pdf) return setError("Choose the TMC document PDF.");

    try {
      const refs: Record<string, { key: string; filename: string }> = {};
      for (const [kind, file] of Object.entries(files) as [FileKind, File][]) {
        setBusy(`Uploading ${file.name}…`);
        refs[kind] = { key: await sendFile(uploadMode, kind, file), filename: file.name };
      }
      setBusy("Saving…");
      const text = (k: string) => String(form.get(k) ?? "");
      const result = await saveDocument({
        type,
        entity,
        productName,
        fileNr,
        batch,
        inciName: text("inciName"),
        casNumber: text("casNumber"),
        poNumber: text("poNumber"),
        language: text("language"),
        manufacturingDate: text("manufacturingDate"),
        expiryOrRetestDate: text("expiryOrRetestDate"),
        supplierName: text("supplierName"),
        tags: text("tags")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        files: refs as { pdf: { key: string; filename: string } },
      });
      if (!result.ok) {
        setBusy(null);
        return setError(result.error);
      }
      router.push(`/documents/${result.id}?ok=${encodeURIComponent(result.message)}`);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? `Upload failed: ${err.message}` : "Upload failed.");
    }
  }

  return (
    <form onSubmit={onSubmit} method="post" action="/upload" className="mt-6 grid gap-6 lg:grid-cols-2">
      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Document</h2>
        <label className="block text-sm">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as NamedType)} className={input}>
            {NAMED_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Entity
          <select value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)} className={input}>
            {ENTITIES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Product name (TMC name) *
          <input value={productName} onChange={(e) => setProductName(e.target.value)} required maxLength={200} className={input} />
        </label>
        {type === "COA" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              Dossier (file nr)
              <input value={fileNr} onChange={(e) => setFileNr(e.target.value)} placeholder="840.S0850" maxLength={50} className={input} />
            </label>
            <label className="block text-sm">
              Batch / lot
              <input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={100} className={input} />
            </label>
          </div>
        )}
        <div className="rounded-md bg-tmc-light px-3 py-2 text-sm">
          <span className="text-gray-600">File name: </span>
          <span className="break-all font-mono text-tmc">{name || "fill in the product name"}</span>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-tmc">More details (optional)</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <label className="block">
              INCI name
              <input name="inciName" maxLength={300} className={input} />
            </label>
            <label className="block">
              CAS number
              <input name="casNumber" maxLength={100} className={input} />
            </label>
            <label className="block">
              PO number
              <input name="poNumber" maxLength={100} className={input} />
            </label>
            <label className="block">
              Language
              <input name="language" defaultValue="EN" maxLength={10} className={input} />
            </label>
            <label className="block">
              Manufacturing date
              <input name="manufacturingDate" type="date" className={input} />
            </label>
            <label className="block">
              Expiry / retest date
              <input name="expiryOrRetestDate" type="date" className={input} />
            </label>
            <label className="block sm:col-span-2">
              Supplier name (internal, never on output)
              <input name="supplierName" maxLength={200} className={input} />
            </label>
            <label className="block sm:col-span-2">
              Tags (comma separated)
              <input name="tags" maxLength={400} className={input} />
            </label>
          </div>
        </details>
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Files</h2>
        {SLOTS.map((s) => (
          <DropZone
            key={s.kind}
            name={s.kind}
            accept={s.accept}
            required={s.required}
            label={s.label}
            help={`${s.help} Max 25 MB.`}
          />
        ))}
        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!!busy || !ready}
          className="w-full rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-60"
        >
          {busy ?? (ready ? "Upload and save" : "Loading…")}
        </button>
      </section>
    </form>
  );
}
