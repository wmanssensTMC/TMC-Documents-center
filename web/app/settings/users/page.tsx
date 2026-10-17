import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ROLES } from "@/lib/db/schema";
import { formatDateTime } from "@/lib/format";
import { listUsers } from "@/lib/users";
import { addUser, changeUser, resetUserPassword } from "./actions";

export const metadata = { title: "Users · TMC Document Center" };

const input = "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none";
const button = "rounded-md bg-tmc px-3 py-1.5 text-sm font-medium text-white hover:bg-tmc/90";

export default async function UsersPage({ searchParams }: PageProps<"/settings/users">) {
  const admin = await requireUser("admin");
  const sp = await searchParams;
  const users = await listUsers(await getDb());

  return (
    <PageShell user={admin}>
      <h1 className="text-xl font-semibold text-tmc">Users</h1>
      <p className="mt-1 text-sm text-gray-600">
        Admin: everything. Approver: upload and approve. User: upload, search and download.
      </p>
      <Notice ok={sp.ok} error={sp.error} />

      <section className="mt-6 rounded-lg bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Add user</h2>
        <form action={addUser} className="mt-3 grid gap-3 sm:grid-cols-5">
          <input name="name" placeholder="Name" required maxLength={100} className={input} />
          <input name="email" type="email" placeholder="E-mail" required maxLength={254} className={input} />
          <select name="role" defaultValue="user" className={input}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input
            name="password"
            type="text"
            placeholder="Temporary password (12+)"
            required
            minLength={12}
            maxLength={256}
            autoComplete="off"
            className={input}
          />
          <button type="submit" className={button}>
            Add
          </button>
        </form>
      </section>

      <section className="mt-6 overflow-x-auto rounded-lg bg-white shadow-sm ring-1 ring-black/5">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-tmc-light text-tmc">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">E-mail</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">New temporary password</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-gray-500">
                  No users yet. You log in with the admin account from the Vercel settings.
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2">
                  {u.name}
                  <div className="text-xs text-gray-500">added {formatDateTime(u.createdAt)}</div>
                </td>
                <td className="px-3 py-2">{u.email}</td>
                <td className="px-3 py-2">
                  <form action={changeUser} className="flex gap-2">
                    <input type="hidden" name="id" value={u.id} />
                    <select name="role" defaultValue={u.role} className={input} aria-label={`Role of ${u.name}`}>
                      {ROLES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                    <button type="submit" className="text-sm text-tmc underline">
                      Save
                    </button>
                  </form>
                </td>
                <td className="px-3 py-2">
                  <form action={changeUser} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="active" value={u.active ? "false" : "true"} />
                    <span className={u.active ? "text-green-700" : "text-gray-500"}>{u.active ? "Active" : "Blocked"}</span>
                    <button type="submit" className="text-sm text-tmc underline">
                      {u.active ? "Block" : "Unblock"}
                    </button>
                  </form>
                  {u.mustChangePassword && <div className="text-xs text-amber-700">must change password</div>}
                </td>
                <td className="px-3 py-2">
                  <form action={resetUserPassword} className="flex gap-2">
                    <input type="hidden" name="id" value={u.id} />
                    <input
                      name="password"
                      type="text"
                      required
                      minLength={12}
                      maxLength={256}
                      autoComplete="off"
                      placeholder="12+ characters"
                      className={`${input} w-40`}
                      aria-label={`New temporary password for ${u.name}`}
                    />
                    <button type="submit" className="text-sm text-tmc underline">
                      Set
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </PageShell>
  );
}
