// File storage behind one small interface. Online: Vercel Blob (private files).
// Laptop: a folder (.data/files). Azure later: a SharePoint library via Graph, same interface.
import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { parseUploadKey } from "../files";

export type StoredFile = { stream: ReadableStream<Uint8Array>; size: number | null; contentType: string | null };

export interface Storage {
  /** "blob": browser uploads straight to Vercel Blob. "local": browser posts to /api/upload-local. */
  readonly mode: "blob" | "local";
  get(key: string): Promise<StoredFile | null>;
  /** First `n` bytes and the size, to check the file signature after upload. */
  head(key: string, n: number): Promise<{ bytes: Uint8Array; size: number } | null>;
  /** Stores a new file (the worker's results). Refuses to overwrite. */
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

let storage: Storage | undefined;

export function getStorage(): Storage {
  storage ??= process.env.BLOB_READ_WRITE_TOKEN ? blobStorage() : localStorage(LOCAL_ROOT);
  return storage;
}

function blobStorage(): Storage {
  return {
    mode: "blob",
    async get(key) {
      const { get } = await import("@vercel/blob");
      const res = await get(key, { access: "private" });
      if (!res?.stream) return null;
      return { stream: res.stream, size: res.blob.size ?? null, contentType: res.blob.contentType ?? null };
    },
    async head(key, n) {
      const file = await this.get(key);
      if (!file) return null;
      const bytes = await readFirst(file.stream, n);
      return { bytes, size: file.size ?? 0 };
    },
    async put(key, data, contentType) {
      if (!parseUploadKey(key)) throw new Error("invalid storage key");
      const { put } = await import("@vercel/blob");
      await put(key, Buffer.from(data), { access: "private", contentType, addRandomSuffix: false, allowOverwrite: false });
    },
  };
}

// ---------------------------------------------------------------- local folder
export const LOCAL_ROOT = path.join(process.cwd(), ".data", "files");

function localPath(root: string, key: string) {
  if (!parseUploadKey(key)) throw new Error("invalid storage key");
  return path.join(root, ...key.split("/"));
}

/** Laptop and tests: files in a folder (default .data/files). */
export function localStorage(root: string): Storage {
  return {
    mode: "local",
    async get(key) {
      const p = localPath(root, key);
      const s = await stat(p).catch(() => null);
      if (!s) return null;
      const stream = Readable.toWeb(createReadStream(p)) as ReadableStream<Uint8Array>;
      return { stream, size: s.size, contentType: null };
    },
    async head(key, n) {
      const p = localPath(root, key);
      const fh = await open(p, "r").catch(() => null);
      if (!fh) return null;
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return { bytes: new Uint8Array(buf.subarray(0, bytesRead)), size: (await fh.stat()).size };
      } finally {
        await fh.close();
      }
    },
    async put(key, data) {
      const p = localPath(root, key);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, data, { flag: "wx" });
    },
  };
}

/** Local mode only (dev upload route). Refuses to overwrite. */
export async function putLocal(key: string, data: Uint8Array) {
  await localStorage(LOCAL_ROOT).put(key, data, "application/octet-stream");
}

async function readFirst(stream: ReadableStream<Uint8Array>, n: number) {
  const reader = stream.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const take = Math.min(n - got, value.length);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}
