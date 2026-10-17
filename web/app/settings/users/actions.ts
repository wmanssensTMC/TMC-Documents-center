"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createUser, resetPassword, updateUser, UserError } from "@/lib/users";

const PAGE = "/settings/users";

async function run(fn: () => Promise<void>, ok: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UserError) redirect(`${PAGE}?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect(`${PAGE}?ok=${encodeURIComponent(ok)}`);
}

export async function addUser(formData: FormData) {
  const admin = await requireUser("admin");
  const db = await getDb();
  await run(
    () =>
      createUser(db, admin, {
        email: formData.get("email"),
        name: formData.get("name"),
        role: formData.get("role"),
        password: formData.get("password"),
      }).then(() => {}),
    "User added. Give them the temporary password; they must change it at first login.",
  );
}

export async function changeUser(formData: FormData) {
  const admin = await requireUser("admin");
  const db = await getDb();
  const active = formData.get("active");
  await run(
    () =>
      updateUser(db, admin, String(formData.get("id")), {
        role: formData.get("role") ?? undefined,
        active: active === null ? undefined : active === "true",
      }),
    "User updated.",
  );
}

export async function resetUserPassword(formData: FormData) {
  const admin = await requireUser("admin");
  const db = await getDb();
  await run(
    () => resetPassword(db, admin, String(formData.get("id")), formData.get("password")),
    "Temporary password set. The user must change it at next login.",
  );
}
