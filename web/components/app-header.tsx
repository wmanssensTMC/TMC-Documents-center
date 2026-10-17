import Image from "next/image";
import Link from "next/link";
import { logout } from "@/app/actions";
import type { CurrentUser } from "@/lib/auth";

export function AppHeader({ user }: { user: CurrentUser }) {
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
          <Link href="/" className="rounded px-3 py-1 hover:bg-white/10">
            Library
          </Link>
          <Link href="/neutralise" className="rounded px-3 py-1 hover:bg-white/10">
            Neutralise
          </Link>
          <Link href="/jobs" className="rounded px-3 py-1 hover:bg-white/10">
            Jobs
          </Link>
          <Link href="/upload" className="rounded px-3 py-1 hover:bg-white/10">
            Upload
          </Link>
          {user.role === "admin" && (
            <Link href="/settings/users" className="rounded px-3 py-1 hover:bg-white/10">
              Settings
            </Link>
          )}
          <Link href="/account/password" className="hidden rounded px-3 py-1 hover:bg-white/10 sm:inline" title="Change password">
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
