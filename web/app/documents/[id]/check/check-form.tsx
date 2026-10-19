"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { sendFile } from "@/lib/client-upload";
import type { YellowPart } from "@/lib/db/schema";
import { MAX_FILE_BYTES } from "@/lib/files";
import { approve, finaliseDraft, reject, type CheckResult } from "./actions";

const input =
  "block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-tmc focus:outline-none focus:ring-1 focus:ring-tmc";
const noSubscribe = () => () => {};

type Props = {
  documentId: string;
  parts: YellowPart[];
  hasPdf: boolean;
  busy: boolean;
  uploadMode: "blob" | "local";
  initial: { productName: string; fileNr: string; batch: string };
};

export function CheckForm({ documentId, parts, hasPdf, busy, uploadMode, initial }: Props) {
  const router = useRouter();
  const ready = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [meta, setMeta] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parts.map((p) => [p.id, p.text])));
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [word, setWord] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const left = parts.filter((p) => !confirmed[p.id]).length;
  const tooLong = parts.some((p) => p.truncated);
  const disabled = !ready || working || busy;

  async function act(fn: () => Promise<CheckResult>) {
    setWorking(true);
    setMessage(null);
    try {
      const r = await fn();
      setMessage(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: "That did not work. Try again." });
    } finally {
      setWorking(false);
    }
  }

  const metadata = { productName: meta.productName, fileNr: meta.fileNr, batch: meta.batch };

  return (
    <div className="mt-6 space-y-6">
      <section className="grid gap-4 rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5 sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">Library details (as printed on the document)</h2>
        <label className="block text-sm">
          Product name (TMC) *
          <input value={meta.productName} onChange={(e) => setMeta({ ...meta, productName: e.target.value })} maxLength={200} className={`mt-1 ${input}`} />
        </label>
        <label className="block text-sm">
          Dossier
          <input value={meta.fileNr} onChange={(e) => setMeta({ ...meta, fileNr: e.target.value })} maxLength={50} className={`mt-1 ${input}`} />
        </label>
        <label className="block text-sm">
          Batch
          <input value={meta.batch} onChange={(e) => setMeta({ ...meta, batch: e.target.value })} maxLength={100} className={`mt-1 ${input}`} />
        </label>
      </section>

      {parts.length > 0 && (
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Yellow parts</h2>
            <span className={`text-sm ${left ? "text-amber-700" : "text-green-700"}`}>
              {left ? `${left} of ${parts.length} still to confirm` : "All confirmed"}
            </span>
          </div>
          <ol className="mt-3 space-y-3">
            {parts.map((p, i) => (
              <li key={p.id} className={`rounded-md p-3 ring-1 ${confirmed[p.id] ? "bg-green-50 ring-green-200" : "bg-yellow-50 ring-yellow-300"}`}>
                <div className="text-xs text-gray-600">
                  {i + 1}. In: <span className="italic">“{p.context || p.text}”</span>
                </div>
                {p.truncated && (
                  <p className="mt-1 text-xs font-medium text-amber-800">
                    Too long for the on-screen check: use “Check in Word yourself” below.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <input
                    value={values[p.id] ?? ""}
                    onChange={(e) => {
                      setValues({ ...values, [p.id]: e.target.value });
                      setConfirmed({ ...confirmed, [p.id]: false });
                    }}
                    maxLength={500}
                    className={`${input} flex-1 sm:min-w-[20rem]`}
                    aria-label={`Value for yellow part ${i + 1}`}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!confirmed[p.id]}
                      onChange={(e) => setConfirmed({ ...confirmed, [p.id]: e.target.checked })}
                    />
                    {values[p.id] === p.text ? "OK as is" : "Use my correction"}
                  </label>
                </div>
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={disabled || left > 0 || tooLong || !meta.productName.trim()}
            onClick={() =>
              act(() =>
                finaliseDraft(documentId, {
                  mode: "editor",
                  metadata,
                  fixes: Object.fromEntries(
                    parts.filter((p) => confirmed[p.id]).map((p) => [p.id, { value: values[p.id] ?? "", confirmed: true as const }]),
                  ),
                }),
              )
            }
            className="mt-4 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-50"
          >
            {busy ? "Being finalised…" : "Finalise: make Word + PDF"}
          </button>
        </section>
      )}

      {parts.length === 0 && hasPdf && (
        <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
          <h2 className="font-semibold">Approve</h2>
          <p className="mt-1 text-sm text-gray-600">Compare the TMC draft with the original. Approving makes it Final.</p>
          <button
            type="button"
            disabled={disabled || !meta.productName.trim()}
            onClick={() => act(() => approve(documentId, metadata))}
            className="mt-3 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-50"
          >
            Approve as Final
          </button>
        </section>
      )}

      <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Or: check in Word yourself</h2>
        <p className="mt-1 text-sm text-gray-600">
          Download the Word draft, correct it, remove every yellow highlight, then upload it here. The neutralizer
          refuses to finalise while anything is still yellow.
        </p>
        <input
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => setWord(e.target.files?.[0] ?? null)}
          className="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-tmc-light file:px-3 file:py-2 file:text-tmc"
          aria-label="Checked Word file"
        />
        <button
          type="button"
          disabled={disabled || !word || !meta.productName.trim()}
          onClick={() =>
            act(async () => {
              if (!word) return { ok: false, error: "Choose the checked Word file." };
              if (word.size > MAX_FILE_BYTES) return { ok: false, error: "The file is larger than 25 MB." };
              const key = await sendFile(uploadMode, "docx", word);
              return finaliseDraft(documentId, { mode: "upload", metadata, docx: { key, filename: word.name } });
            })
          }
          className="mt-3 rounded-md border border-tmc px-4 py-2 text-sm font-medium text-tmc hover:bg-tmc-light disabled:opacity-50"
        >
          Upload checked Word and finalise
        </button>
      </section>

      <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Reject this draft</h2>
        <p className="mt-1 text-sm text-gray-600">The reason goes to the feedback overview, to improve the neutralizer.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="What is wrong?" className={`${input} flex-1`} aria-label="Reason for rejecting" />
          <button
            type="button"
            disabled={disabled || reason.trim().length < 3}
            onClick={() => act(() => reject(documentId, reason))}
            className="rounded-md border border-red-700 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </section>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`rounded-md px-3 py-2 text-sm ring-1 ${message.ok ? "bg-green-50 text-green-800 ring-green-200" : "bg-red-50 text-red-800 ring-red-200"}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
