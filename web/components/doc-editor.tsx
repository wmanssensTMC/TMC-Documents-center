"use client";

// The on-screen Word editor of the check screen (Willem 19/10, option A): the draft is edited as
// the document itself, with free formatting. The editor library sits behind this one component,
// so it can be swapped (for example for Word for the web in phase 4) without touching the pages.
// Everything runs in the browser; the document is never sent anywhere but this app.
import "superdoc/style.css";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type DocEditorHandle = { exportDocx: () => Promise<Blob> };
export type DocEditorState = "loading" | "ready" | "error";

type Instance = { export: (o: { exportType: string[]; triggerDownload: boolean }) => Promise<Blob>; destroy: () => void };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function DocEditor({ src, onState, ref }: { src: string; onState: (s: DocEditorState) => void; ref: Ref<DocEditorHandle> }) {
  const bar = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Instance | null>(null);
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });

  useEffect(() => {
    let cancelled = false;
    let instance: Instance | null = null;
    let ready = false;
    report.current("loading");
    (async () => {
      const res = await fetch(src, { cache: "no-store" });
      if (!res.ok) throw new Error("draft not available");
      const file = new File([await res.blob()], "draft.docx", { type: DOCX });
      const { SuperDoc } = await import("superdoc");
      if (cancelled || !host.current || !bar.current) return;
      instance = new SuperDoc({
        selector: host.current,
        toolbar: bar.current,
        document: file,
        documentMode: "editing",
        // never report documents to the editor's maker: these are confidential (TMC)
        telemetry: { enabled: false },
        // a closed instance (React mounts twice in development) must not report anything
        onReady: () => {
          if (cancelled) return;
          ready = true;
          report.current("ready");
        },
        onException: (e: unknown) => {
          console.warn("document editor", e);
          if (!cancelled && !ready) report.current("error"); // after loading: not fatal
        },
      }) as unknown as Instance;
      editor.current = instance;
    })().catch(() => !cancelled && report.current("error"));
    return () => {
      cancelled = true;
      editor.current = null;
      instance?.destroy();
    };
  }, [src]);

  useImperativeHandle(ref, () => ({
    exportDocx: async () => {
      if (!editor.current) throw new Error("the editor is not ready");
      return editor.current.export({ exportType: ["docx"], triggerDownload: false });
    },
  }));

  return (
    <div className="min-w-0 overflow-hidden rounded border bg-white">
      <div ref={bar} className="overflow-x-auto border-b" />
      <div ref={host} className="h-[75vh] overflow-auto" />
    </div>
  );
}
