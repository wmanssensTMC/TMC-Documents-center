"use client";

import { useActionState } from "react";
import { API_JOB_KINDS } from "@/lib/constants";
import { makeKey, type NewKeyResult } from "./actions";

const input = "rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none";

export function NewKeyForm() {
  const [result, action, pending] = useActionState<NewKeyResult, FormData>(makeKey, null);
  return (
    <form action={action} className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input name="client" defaultValue="tmclog" required pattern="[a-z0-9]{2,16}" maxLength={16} aria-label="Client" className={input} />
        {API_JOB_KINDS.map((k) => (
          <label key={k} className="flex items-center gap-1 text-sm">
            <input type="checkbox" name="kinds" value={k} defaultChecked /> {k}
          </label>
        ))}
        <button disabled={pending} className="rounded-md bg-tmc px-3 py-1.5 text-sm font-medium text-white hover:bg-tmc/90 disabled:opacity-60">
          Make key
        </button>
      </div>
      {result?.ok === false && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
          {result.error}
        </p>
      )}
      {result?.ok && (
        <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="font-medium">Copy this key now: it is shown only once and cannot be read back.</p>
          <code className="mt-1 block break-all rounded bg-white px-2 py-1 font-mono text-xs select-all">{result.key}</code>
          <p className="mt-1 text-xs">
            Put it in TMC Logistics as DOCUMENT_CENTER_API_KEY (app/.env.local now, Key Vault later). Never in mail, chat or
            Git. Then deactivate the old key below.
          </p>
        </div>
      )}
    </form>
  );
}
