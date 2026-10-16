"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const input =
  "mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-base focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <form action={action} className="mt-6 space-y-4">
      <label className="block text-sm">
        E-mail
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          defaultValue={state.email}
          key={state.email}
          className={input}
        />
      </label>
      <label className="block text-sm">
        Password
        <input name="password" type="password" autoComplete="current-password" required className={input} />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-60"
      >
        {pending ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}
