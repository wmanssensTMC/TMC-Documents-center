// File download / preview. Always through the app: login checked, every access logged.
import { logAudit } from "@/lib/audit";
import { apiUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getDocument } from "@/lib/documents/service";
import { detectType, DOCUMENT_FILE_KINDS, EXTENSION } from "@/lib/files";
import { getStorage } from "@/lib/storage";

export async function GET(req: Request, ctx: RouteContext<"/api/files/[id]/[kind]">) {
  const user = await apiUser();
  if (!user) return new Response("Not logged in", { status: 401 });

  const { id, kind: rawKind } = await ctx.params;
  const kind = DOCUMENT_FILE_KINDS.find((k) => k === rawKind);
  if (!kind) return new Response("Not found", { status: 404 });

  const db = await getDb();
  const doc = await getDocument(db, id);
  const key = doc && { pdf: doc.pdfKey, docx: doc.docxKey, source: doc.sourceKey, preview: doc.previewKey, view: doc.viewKey }[kind];
  if (!doc || !key) return new Response("Not found", { status: 404 });

  const storage = getStorage();
  const head = await storage.head(key, 8);
  const type = head && detectType(kind, head.bytes);
  const file = type ? await storage.get(key) : null;
  if (!type || !file) return new Response("File missing", { status: 404 });

  // The DRAFT preview is for the check screen only: always shown, never a download.
  // The editor's view is read by the check screen itself: counted as viewed, never shown as a page.
  const inline = kind === "preview" || kind === "view" || (new URL(req.url).searchParams.get("inline") === "1" && type === "application/pdf");
  const filename =
    kind === "source"
      ? (doc.sourceFilename ?? `source${EXTENSION[type]}`)
      : `${doc.name}${kind === "preview" ? "_DRAFT_PREVIEW" : kind === "view" ? "_EDITOR_VIEW" : ""}${EXTENSION[type]}`;
  await logAudit(db, user, inline ? "document.viewed" : "document.downloaded", doc.id, { file: kind });

  const headers = new Headers({
    "Content-Type": type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  // Downloads never run as a page of this site. (Not on inline PDFs: browsers refuse to show
  // a PDF under a sandbox policy; inline is limited to real PDFs above.)
  if (!inline || kind === "view") headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  if (file.size) headers.set("Content-Length", String(file.size));
  return new Response(file.stream, { headers });
}
