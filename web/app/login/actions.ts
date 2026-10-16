"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export type LoginState = { error?: string; email?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Fill in e-mail and password.", email };

  const ok = await signIn(email, password);
  if (!ok) {
    // Small fixed delay slows down password guessing.
    await new Promise((r) => setTimeout(r, 800));
    return { error: "E-mail or password is not correct.", email };
  }
  redirect("/");
}
