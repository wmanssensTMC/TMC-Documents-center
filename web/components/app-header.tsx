import Image from "next/image";
import Link from "next/link";
import { logout } from "@/app/actions";
import type { CurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { countToCheck } from "@/lib/documents/service";

const tab = "rounded px-3 py-1 hover:bg-white/10";

// Five tabs, in the order of the work (Willem 22/10): Jobs is part of Neutralise, Upload is a
// button in the Library.
export async function AppHeader({ user }: { user: CurrentUser }) {
  const waiting = await countToCheck(await getDb());
  return (
    <header className="bg-tmc text-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-3">
          <span className="rounded bg-white p-1">
            <Image src="/tmc-logo.png" alt="Transmare Chemie" width={295} height={280} className="h-9 w-auto" />
          </span>
          <span className="font-semibold">Document Center</span>
        </Link>
        <nav className="flex flex-wrap items-center gap-1 text-sm">
          <Link href="/neutralise" className={tab}>
            Neutralise
          </Link>
          <Link href="/?status=To%20check" className={tab}>
            To check
            {waiting > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-xs font-semibold text-tmc" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            )}
          </Link>
          <Link href="/labels/new" className={tab}>
            Labels
          </Link>
          <Link href="/" className={tab}>
            Library
          </Link>
          {user.role === "admin" && (
            <Link href="/settings/users" className={tab}>
              Settings
            </Link>
          )}
          <Link href="/account/password" className={`hidden sm:inline ${tab}`} title="Change password">
            {user.name}
          </Link>
          <form action={logout}>
            <button type="submit" className="rounded border border-white/40 px-3 py-1 hover:bg-white/10">
              Log out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}

export function PageShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </>
  );
}
