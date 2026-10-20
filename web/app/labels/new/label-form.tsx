"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { ENTITIES, type Entity, type LabelLanguage } from "@/lib/constants";
import { LABEL_FIELDS, LABEL_LANGUAGES, LABEL_TEMPLATES, type LabelFieldKey } from "@/lib/labels/templates";
import { submitLabel } from "./actions";

type Coa = {
  id: string;
  name: string;
  entity: Entity;
  productName: string | null;
  fileNr: string | null;
  batch: string | null;
  manufacturingDate: string | null;
  expiryOrRetestDate: string | null;
};

const LANGUAGE_LABEL: Record<LabelLanguage, string> = { EN: "English", FR: "French" };
const input =
  "block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";
const noSubscribe = () => () => {};
const empty = { productName: "", fileNr: "", batch: "", productionDate: "", expiryDate: "", netWeight: "", grossWeight: "" };

export function LabelForm({ entitiesWithDetails, coas }: { entitiesWithDetails: string[]; coas: Coa[] }) {
  const router = useRouter();
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [template, setTemplate] = useState(LABEL_TEMPLATES[0].id);
  const [language, setLanguage] = useState<LabelLanguage>("EN");
  const [entity, setEntity] = useState<Entity>("TMC");
  const [coaId, setCoaId] = useState("");
  const [values, setValues] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof empty, value: string) => setValues((v) => ({ ...v, [key]: value }));

  // Only what the COA itself holds; an empty value stays empty for the person to fill in.
  function fromCoa(id: string) {
    setCoaId(id);
    const c = coas.find((x) => x.id === id);
    if (!c) return;
    setEntity(c.entity);
    setValues((v) => ({
      ...v,
      productName: c.productName ?? "",
      fileNr: c.fileNr ?? "",
      batch: c.batch ?? "",
      productionDate: c.manufacturingDate ?? "",
      expiryDate: c.expiryOrRetestDate ?? "",
    }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result = await submitLabel({ template, language, entity, ...values });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    router.push("/jobs");
  }

  return (
    <form onSubmit={onSubmit} method="post" action="/labels/new" className="mt-6 space-y-6">
      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5 sm:grid-cols-3">
        <label className="block text-sm">
          Template
          <select value={template} onChange={(e) => setTemplate(e.target.value)} className={`mt-1 ${input}`}>
            {LABEL_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value as LabelLanguage)} className={`mt-1 ${input}`}>
            {LABEL_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABEL[l]}
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
      </section>

      <section className="space-y-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <label className="block text-sm">
          Start from a Final COA (optional)
          <select value={coaId} onChange={(e) => fromCoa(e.target.value)} className={`mt-1 ${input}`}>
            <option value="">Type the values myself</option>
            {coas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-gray-500">Fills in product, dossier, batch and the dates the COA holds. You can still change them.</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            Product name (TMC) *
            <input value={values.productName} onChange={(e) => set("productName", e.target.value)} required maxLength={200} className={`mt-1 ${input}`} />
          </label>
          <label className="block text-sm">
            Dossier
            <input value={values.fileNr} onChange={(e) => set("fileNr", e.target.value)} maxLength={50} placeholder="840.S0850" className={`mt-1 ${input}`} />
          </label>
          <label className="block text-sm">
            Batch *
            <input value={values.batch} onChange={(e) => set("batch", e.target.value)} required maxLength={100} className={`mt-1 ${input}`} />
          </label>
          {LABEL_FIELDS.map((f) => (
            <label key={f.key} className="block text-sm">
              {f.label}
              <input
                type={f.kind === "date" ? "date" : "text"}
                inputMode={f.kind === "number" ? "decimal" : undefined}
                value={values[f.key as LabelFieldKey]}
                onChange={(e) => set(f.key, e.target.value)}
                maxLength={20}
                className={`mt-1 ${input}`}
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-gray-500">An empty field is left off the label. Dates are printed dd/mm/yyyy.</p>
      </section>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!ready || busy}
        className="w-full rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-60 sm:w-auto"
      >
        {busy ? "Sending…" : ready ? "Make the label" : "Loading…"}
      </button>
    </form>
  );
}
