import { redirect } from "next/navigation";
import { PageShell } from "@/components/app-header";
import { Notice } from "@/components/notice";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { changeOwnPassword, UserError } from "@/lib/users";

export const metadata = { title: "Password · TMC Document Center" };

const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";

async function changePassword(formData: FormData) {
  "use server";
  const user = await requireUser("user", { allowPasswordChange: true });
  const next = formData.get("next");
  if (next !== formData.get("confirm")) redirect("/account/password?error=The%20two%20new%20passwords%20differ.");
  try {
    await changeOwnPassword(await getDb(), user, formData.get("current"), next);
  } catch (err) {
    if (err instanceof UserError) redirect(`/account/password?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect("/?ok=Password%20changed.");
}

export default async function PasswordPage({ searchParams }: PageProps<"/account/password">) {
  const user = await requireUser("user", { allowPasswordChange: true });
  const sp = await searchParams;

  return (
    <PageShell user={user}>
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-semibold text-tmc">Change password</h1>
        {user.mustChangePassword && (
          <p className="mt-2 text-sm text-amber-800">You are using a temporary password. Choose your own to continue.</p>
        )}
        <Notice error={sp.error} />
        {user.source === "env" ? (
          <p className="mt-4 text-sm text-gray-700">
            This admin account&apos;s password is set in the Vercel settings (ADMIN_PASSWORD_HASH). Change it there with{" "}
            <code>npm run hash-password</code>.
          </p>
        ) : (
          <form action={changePassword} className="mt-4 space-y-4 rounded-lg bg-white p-6 shadow-sm ring-1 ring-black/5">
            <label className="block text-sm">
              Current password
              <input name="current" type="password" required autoComplete="current-password" maxLength={256} className={input} />
            </label>
            <label className="block text-sm">
              New password (at least 12 characters)
              <input name="next" type="password" required minLength={12} maxLength={256} autoComplete="new-password" className={input} />
            </label>
            <label className="block text-sm">
              New password again
              <input name="confirm" type="password" required minLength={12} maxLength={256} autoComplete="new-password" className={input} />
            </label>
            <button type="submit" className="w-full rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90">
              Save password
            </button>
          </form>
        )}
      </div>
    </PageShell>
  );
}
