"use server";

import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

export type LoginState = { error?: string; email?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Fill in e-mail and password.", email };
  if (email.length > 254 || password.length > 256) return { error: "E-mail or password is not correct." };

  const result = await signIn(email, password);
  if (result === "locked") return { error: "Too many failed attempts. Try again in 15 minutes.", email };
  if (result === "busy") return { error: "The server is busy. Try again in a moment.", email };
  if (result === "invalid") {
    // Small fixed delay slows down password guessing.
    await new Promise((r) => setTimeout(r, 800));
    return { error: "E-mail or password is not correct.", email };
  }
  redirect("/");
}
