"use client";

// Edit the draft as a document (Willem 19/10, option A; own editor 20/10). Screen by screen:
// supplier original left, the TMC document being edited right. Saving sends only the changed
// pieces of text; the worker writes them into the draft and runs every check of a Final.
// Changes not found in the original come back as warnings.
import { useRef, useState } from "react";
import { DocEditor, type DocEditorHandle, type DocEditorState } from "@/components/doc-editor";
import type { Change } from "@/lib/documents/changes";
import type { Edits } from "@/lib/documents/edits";
import type { DocMetadata } from "@/lib/db/schema";
import { finaliseDraft, type CheckResult } from "./actions";

export type EditProps = {
  documentId: string;
  sourceUrl: string | null;
  /** the editor view of the draft; null for a draft made before the own editor */
  viewUrl: string | null;
  /** the last edit that did not become Final, to go on from */
  pending: { edits: Edits; warnings: Change[] } | null;
};

type Props = EditProps & {
  metadata: Omit<DocMetadata, "fileNr" | "batch"> & { fileNr: string; batch: string };
  confirmReplace: boolean;
  disabled: boolean;
  act: (fn: () => Promise<CheckResult>) => Promise<void>;
};

export function EditSection(p: Props) {
  const [state, setState] = useState<DocEditorState>("loading");
  const [accept, setAccept] = useState(false);
  const editor = useRef<DocEditorHandle>(null);
  const warnings = p.pending?.warnings ?? [];

  // A confirmation only ever covers the warnings shown, so only the changes they belong to;
  // a new edit is compared again and shows its own warnings.
  const finalise = (edits: Edits, acceptChanges: boolean) =>
    finaliseDraft(p.documentId, { mode: "edited", metadata: p.metadata, confirmReplace: p.confirmReplace, acceptChanges, edits });

  async function saveAndFinalise(): Promise<CheckResult> {
    if (!editor.current) return { ok: false, error: "The editor is still loading." };
    return finalise(editor.current.getEdits(), false);
  }

  if (!p.viewUrl) {
    return (
      <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Edit the document</h2>
        <p className="mt-1 text-sm text-gray-600">
          This draft was made before the on-screen editor. Run the supplier document again to edit it here, or use the
          yellow parts below or the Word file.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-black/5">
      {/* Open straight away: checking means editing in place (Willem 26/10, first live run). */}
      <h2 className="font-semibold">Check and edit the document{p.pending ? " (your last edit)" : ""}</h2>
      <p className="mt-1 text-sm text-gray-600">
        Click in any text to change it; Enter starts a new line. Select text for bold, italic, underline or bigger and
        smaller letters; click in a paragraph to align it; click in a table cell to add or delete rows and columns.
        Check every yellow part and remove its yellow: nothing yellow can become Final. When you save, the neutralizer
        checks the document again, also its layout (nothing over the TMC letterhead, nothing cut off), and makes the
        Word file and the PDF.
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
              onClick={() => p.act(() => finalise(p.pending!.edits, true))}
              className="mt-3 rounded-md bg-tmc px-4 py-2 font-medium text-white hover:bg-tmc/90 disabled:opacity-50"
            >
              Finalise my last edit
            </button>
          )}
        </div>
      )}

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
          <DocEditor ref={editor} src={p.viewUrl} pending={p.pending?.edits ?? null} onState={setState} />
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
    </section>
  );
}
