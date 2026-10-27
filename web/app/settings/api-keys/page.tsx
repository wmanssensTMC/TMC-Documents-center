import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { SettingsNav } from "@/components/settings-nav";
import { apiEnabled } from "@/lib/api/http";
import { listApiKeys, MAX_ACTIVE_KEYS } from "@/lib/api/keys";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { deactivateKey } from "./actions";
import { NewKeyForm } from "./new-key-form";

export const metadata = { title: "API keys · TMC Document Center" };

export default async function ApiKeysPage({ searchParams }: PageProps<"/settings/api-keys">) {
  const admin = await requireUser("admin");
  const sp = await searchParams;
  const keys = await listApiKeys(await getDb());

  return (
    <PageShell user={admin}>
      <SettingsNav current="api-keys" />
      <h1 className="mt-4 text-xl font-semibold text-tmc">API keys</h1>
      <p className="mt-1 text-sm text-gray-600">
        Keys for apps that send document requests (TMC Logistics = client tmclog). At most {MAX_ACTIVE_KEYS} active keys per
        app, so a new key can be made before the old one is switched off (every 90 days, and at once when a key may be known
        to someone else). Only a fingerprint of each key is stored.
      </p>
      <p className={`mt-2 text-sm font-medium ${apiEnabled() ? "text-green-700" : "text-amber-800"}`}>
        {apiEnabled()
          ? "The API is on (API_CLIENTS_ENABLED=on)."
          : "The API is off: every call is refused until API_CLIENTS_ENABLED=on is set on Vercel."}
      </p>
      <Notice ok={sp.ok} error={sp.error} />

      <section className="mt-6 rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Make a key</h2>
        <NewKeyForm />
      </section>

      <div className="mt-6 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-tmc-light text-tmc">
            <tr>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Key ends in</th>
              <th className="px-3 py-2">May ask for</th>
              <th className="px-3 py-2">Made</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  No keys yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className={`border-t border-gray-100 align-top ${k.active ? "" : "text-gray-400"}`}>
                <td className="px-3 py-2 font-medium">{k.client}</td>
                <td className="px-3 py-2 font-mono">…{k.keyHint}</td>
                <td className="px-3 py-2 text-xs">{k.allowedKinds.join(", ")}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatDateTime(k.createdAt)}
                  <div className="text-xs text-gray-500">{k.createdBy}</div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "Never"}</td>
                <td className="px-3 py-2">
                  {k.active ? (
                    <form action={deactivateKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <button className="text-sm text-red-700 underline">Deactivate</button>
                    </form>
                  ) : (
                    `Deactivated ${formatDateTime(k.deactivatedAt)}`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageShell>
  );
}
