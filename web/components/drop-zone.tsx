"use client";

import { useRef, useState } from "react";

type Props = {
  /** Form field name: the dropped files land in this input, so the form reads them as usual. */
  name?: string;
  accept: string;
  multiple?: boolean;
  required?: boolean;
  label: string;
  help?: string;
  /** Called with the chosen or dropped files (after the accept check). */
  onFiles?: (files: File[]) => void;
};

/** Drag-and-drop area with a normal file picker inside (BRIEF screen 3). */
export function DropZone({ name, accept, multiple, required, label, help, onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  const allowed = accept.split(",").map((a) => a.trim().toLowerCase());
  const ok = (f: File) =>
    allowed.some((a) => (a.startsWith(".") ? f.name.toLowerCase().endsWith(a) : f.type === a));

  function take(list: FileList | null, fromDrop: boolean) {
    const files = Array.from(list ?? []);
    const good = files.filter(ok).slice(0, multiple ? undefined : 1);
    setWarning(files.length > good.length ? "Some files were skipped: wrong type." : null);
    if (fromDrop && input.current) {
      const dt = new DataTransfer();
      good.forEach((f) => dt.items.add(f));
      input.current.files = dt.files;
    }
    setChosen(good.map((f) => f.name));
    if (good.length) onFiles?.(good);
  }

  return (
    <div>
      <span className="block text-sm">
        {label}
        {required && " *"}
      </span>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files, true);
        }}
        className={`mt-1 flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-5 text-center text-sm transition ${
          over ? "border-tmc bg-tmc-light" : "border-gray-300 bg-gray-50 hover:border-tmc"
        }`}
      >
        <span className="font-medium text-tmc">Drop {multiple ? "files" : "a file"} here</span>
        <span className="text-xs text-gray-500">or click to choose</span>
        <input
          ref={input}
          name={name}
          type="file"
          accept={accept}
          multiple={multiple}
          required={required && chosen.length === 0}
          onChange={(e) => take(e.target.files, false)}
          className="sr-only"
        />
      </label>
      {chosen.length > 0 && !onFiles && <p className="mt-1 break-all text-xs text-gray-700">{chosen.join(", ")}</p>}
      {warning && <p className="mt-1 text-xs text-amber-800">{warning}</p>}
      {help && <p className="mt-1 text-xs text-gray-500">{help}</p>}
    </div>
  );
}
