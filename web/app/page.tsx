import Image from "next/image";
import { redirect } from "next/navigation";
import { requireUser, signOut } from "@/lib/auth";

async function logout() {
  "use server";
  await signOut();
  redirect("/login");
}

export default async function HomePage() {
  const user = await requireUser();

  return (
    <>
      <header className="bg-tmc text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="rounded bg-white p-1">
              <Image src="/tmc-logo.png" alt="Transmare Chemie" width={295} height={280} className="h-9 w-auto" />
            </span>
            <span className="font-semibold">Document Center</span>
          </div>
          <form action={logout} className="flex items-center gap-3 text-sm">
            <span className="hidden sm:inline">{user.name}</span>
            <button type="submit" className="rounded border border-white/40 px-3 py-1 hover:bg-white/10">
              Log out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <h1 className="text-xl font-semibold text-tmc">Welcome, {user.name}</h1>
        <p className="mt-2 text-gray-600">
          Phase 0 is live: login and hosting work. The document library comes in phase 1.
        </p>
      </main>
    </>
  );
}
