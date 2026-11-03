"use client";

// "Run again with the latest neutralizer" (Willem 02/11): the same supplier document and values,
// no new upload. The draft stays until the new run has made its own.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rerunDraft } from "./actions";

export function RerunButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await rerunDraft(documentId);
            if (!r.ok) return setError(r.error);
            router.push(`/jobs?ok=${encodeURIComponent("Running again with the latest neutralizer. The old draft stays until the new one is ready.")}`);
          })
        }
        className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light disabled:opacity-50"
        title="The same supplier document and values, read again by the latest neutralizer"
      >
        {pending ? "Sending…" : "Run again with the latest neutralizer"}
      </button>
      {error && <span className="mt-1 max-w-xs text-xs text-red-700">{error}</span>}
    </span>
  );
}
