"use client";

// Edit the draft as a document (Willem 19/10, option A). Screen by screen: supplier original left,
// the TMC document being edited right. Saving sends the edited Word file to the worker, which
// runs every check of a Final; changes not found in the original come back as warnings.
import { useRef, useState } from "react";
import { DocEditor, type DocEditorHandle, type DocEditorState } from "@/components/doc-editor";
import { sendFile } from "@/lib/client-upload";
import type { Change } from "@/lib/documents/changes";
import type { DocMetadata } from "@/lib/db/schema";
import { MAX_FILE_BYTES } from "@/lib/files";
import { finaliseDraft, type CheckResult } from "./actions";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type EditProps = {
  documentId: string;
  sourceUrl: string | null;
  draftUrl: string;
  /** the last edit that did not become Final, to go on from */
  pending: { url: string; key: string; filename: string; warnings: Change[] } | null;
};

type Props = EditProps & {
  uploadMode: "blob" | "local";
  metadata: Omit<DocMetadata, "fileNr" | "batch"> & { fileNr: string; batch: string };
  name: string;
  confirmReplace: boolean;
  disabled: boolean;
  act: (fn: () => Promise<CheckResult>) => Promise<void>;
};

export function EditSection(p: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DocEditorState>("loading");
  const [accept, setAccept] = useState(false);
  const editor = useRef<DocEditorHandle>(null);
  const warnings = p.pending?.warnings ?? [];

  // A confirmation only ever covers the warnings shown, so only the saved version they belong to;
  // a new edit is compared again and shows its own warnings.
  const finalise = (docx: { key: string; filename: string }, acceptChanges: boolean) =>
    finaliseDraft(p.documentId, { mode: "edited", metadata: p.metadata, confirmReplace: p.confirmReplace, acceptChanges, docx });

  async function saveAndFinalise(): Promise<CheckResult> {
    if (!editor.current) return { ok: false, error: "The editor is not open." };
    const blob = await editor.current.exportDocx();
    if (blob.size > MAX_FILE_BYTES) return { ok: false, error: "The document is larger than 25 MB." };
    const filename = `${p.name}.docx`;
    const key = await sendFile(p.uploadMode, "docx", new File([blob], filename, { type: DOCX }));
    return finalise({ key, filename }, false);
  }

  return (
    <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Edit the document</h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-md border border-tmc px-3 py-1.5 text-sm font-medium text-tmc hover:bg-tmc-light"
          >
            {p.pending ? "Open my last edit" : "Open the editor"}
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-600">
        Change any text and its formatting. Check every yellow part and remove its highlight: nothing yellow can become
        Final. When you save, the neutralizer checks the document again and makes the Word file and the PDF.
      </p>

      {warnings.length > 0 && (
        <div className="mt-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-300">
          <p className="font-medium">
            {warnings.length} change(s) bring in words or numbers that are not in the supplier original. Check them:
          </p>
          <ul className="mt-2 space-y-2">
            {warnings.map((w, i) => (
              <li key={i} className="rounded bg-white p-2 ring-1 ring-amber-200">
                <div className="text-xs text-gray-500 line-through">{w.before || "(new text)"}</div>
                <div>{w.after || "(removed)"}</div>
                <div className="mt-1 text-xs">
                  Not in the original: <span className="font-mono font-semibold">{w.unknown.join("  ")}</span>
                </div>
              </li>
            ))}
          </ul>
          <label className="mt-3 flex items-center gap-2">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            I checked these changes; they are correct
          </label>
          {p.pending && (
            <button
              type="button"
              disabled={p.disabled || !accept || !p.metadata.productName.trim()}
              onClick={() => p.act(() => finalise({ key: p.pending!.key, filename: p.pending!.filename }, true))}
              className="mt-3 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-50"
            >
              Finalise my last edit
            </button>
          )}
        </div>
      )}

      {open && (
        <>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="mb-1 text-sm font-semibold text-gray-700">Supplier original</h3>
              {p.sourceUrl ? (
                <iframe src={p.sourceUrl} title="Supplier original (editor)" className="h-[80vh] w-full rounded border bg-white" />
              ) : (
                <p className="rounded border bg-white p-4 text-sm text-gray-600">No original stored.</p>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="mb-1 text-sm font-semibold text-gray-700">
                TMC document {state === "loading" ? "(loading…)" : state === "error" ? "(could not be opened)" : ""}
              </h3>
              <DocEditor ref={editor} src={p.pending?.url ?? p.draftUrl} onState={setState} />
            </div>
          </div>
          <button
            type="button"
            disabled={p.disabled || state !== "ready" || !p.metadata.productName.trim()}
            onClick={() => p.act(saveAndFinalise)}
            className="mt-4 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-50"
          >
            Save and finalise: make Word + PDF
          </button>
        </>
      )}
    </section>
  );
}
