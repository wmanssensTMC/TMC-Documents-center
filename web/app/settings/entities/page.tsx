import { redirect } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { SettingsNav } from "@/components/settings-nav";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ENTITIES } from "@/lib/db/schema";
import { ENTITY_FIELDS, EntityError, listEntities, saveEntity } from "@/lib/entities";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Entities · TMC Document Center" };

async function save(formData: FormData) {
  "use server";
  const admin = await requireUser("admin");
  const code = String(formData.get("code") ?? "");
  try {
    await saveEntity(await getDb(), admin, code, Object.fromEntries(ENTITY_FIELDS.map((f) => [f.key, formData.get(f.key)])));
  } catch (err) {
    if (err instanceof EntityError) redirect(`/settings/entities?error=${encodeURIComponent(`${code}: ${err.message}`)}`);
    throw err;
  }
  redirect(`/settings/entities?ok=${encodeURIComponent(`${code} saved.`)}`);
}

const input = "mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none";

export default async function EntitiesPage({ searchParams }: PageProps<"/settings/entities">) {
  const admin = await requireUser("admin");
  const sp = await searchParams;
  const records = await listEntities(await getDb());

  return (
    <PageShell user={admin}>
      <SettingsNav current="entities" />
      <h1 className="mt-4 text-xl font-semibold text-tmc">Entities</h1>
      <p className="mt-1 text-sm text-gray-600">
        The details the neutralizer prints for each entity. Only enter details you have from the company itself: they
        are never filled in automatically. Without details, documents for that entity cannot be neutralised.
      </p>
      <Notice ok={sp.ok} error={sp.error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {ENTITIES.map((code) => {
          const rec = records.find((r) => r.code === code);
          return (
            <form key={code} action={save} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
              <input type="hidden" name="code" value={code} />
              <h2 className="font-semibold">{code}</h2>
              <p className="text-xs text-gray-500">
                {rec ? `Last saved by ${rec.updatedBy}, ${formatDateTime(rec.updatedAt)}` : "No details yet"}
              </p>
              {ENTITY_FIELDS.map((f) => (
                <label key={f.key} className="mt-3 block text-sm">
                  {f.label}
                  <input name={f.key} defaultValue={rec?.[f.key] ?? ""} required maxLength={300} className={input} />
                </label>
              ))}
              <button type="submit" className="mt-4 rounded-md bg-tmc px-3 py-1.5 text-sm font-medium text-white">
                Save {code}
              </button>
            </form>
          );
        })}
      </div>
    </PageShell>
  );
}
