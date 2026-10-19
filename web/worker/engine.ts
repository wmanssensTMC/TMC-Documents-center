// Runs the existing Python engine (engine/scripts/neutralize.py) unchanged. Its provenance gate
// and yellow review run inside it; nothing here can switch them off.
//
// Safety (security reviews N2/N3/W1/W3): an argument list, never a shell; values passed as
// --option=value so text starting with "-" cannot become an option; the engine gets no secrets
// (no database or storage keys in its environment); a timeout stops the whole process group
// (LibreOffice and OCR included); the log is capped and stripped of server paths.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const ENGINE_DIR = process.env.ENGINE_DIR ?? path.resolve(__dirname, "..", "..", "engine");
const PYTHON = process.env.ENGINE_PYTHON ?? "python3";
const TIMEOUT_MS = 10 * 60 * 1000;
const LOG_MAX = 8000;
const OUTPUT_KEEP = 256 * 1024;

export type EngineRun = { code: number; log: string; stdout: string };

export type EngineArgs = {
  inputs: string[]; // files in the job folder, supplier document first
  outDir: string;
  entityJson: string;
  workDir: string; // the job folder; also HOME for LibreOffice
  route: "auto" | "coa" | "sds" | "tds";
  productName?: string | null;
  fileNr?: string | null;
  batch?: string | null;
};

export function engineArgv(a: EngineArgs): string[] {
  const argv = ["-I", path.join(ENGINE_DIR, "scripts", "neutralize.py"), ...a.inputs, `--output-dir=${a.outDir}`, `--entity=${a.entityJson}`];
  if (a.productName) argv.push(`--product-name=${a.productName}`);
  if (a.fileNr) argv.push(`--file-nr=${a.fileNr}`);
  if (a.batch) argv.push(`--batch=${a.batch}`);
  if (a.route !== "auto") argv.push(`--type=${a.route}`);
  return argv;
}

/** The engine's own --finalise: renders the PDF, refuses while anything is still yellow. */
export function finaliseArgv(docx: string): string[] {
  return ["-I", path.join(ENGINE_DIR, "scripts", "neutralize.py"), docx, "--finalise"];
}

/** keepStdout: also return standard output on its own (machine-readable output of yellow.py). */
export function runPython(argv: string[], workDir: string, opts: { keepStdout?: boolean } = {}): Promise<EngineRun> {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
  } as unknown as NodeJS.ProcessEnv; // only these: the engine gets no secrets
  return new Promise((resolve) => {
    // Own process group, so a timeout also stops the LibreOffice/OCR the engine started.
    const child = spawn(PYTHON, argv, {
      cwd: workDir,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let stdout = "";
    let stdoutTooLong = false;
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-OUTPUT_KEEP); // bounded memory
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (opts.keepStdout) {
        if (stdout.length + chunk.length > 2 * 1024 * 1024) stdoutTooLong = true;
        else stdout += chunk.toString("utf8");
      } else keep(chunk);
    });
    child.stderr.on("data", keep);

    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, TIMEOUT_MS);
    const finish = (exitCode: number, note = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const tooLong = stdoutTooLong ? "\n[worker] output too long" : "";
      resolve({ code: tooLong ? 1 : exitCode, log: cleanLog(out + note + tooLong, workDir), stdout });
    };
    child.on("error", (err: NodeJS.ErrnoException) => finish(1, `\n[worker] could not start the engine (${err.code ?? "error"})`));
    child.on("close", (code) => {
      killTree(child.pid); // leftovers of a finished run are stopped too
      if (timedOut) finish(1, "\n[worker] stopped: the run took longer than 10 minutes");
      else finish(code ?? 1);
    });
  });
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // already gone
  }
}

const HIDE: [string, string][] = [
  [ENGINE_DIR, "<engine>"],
  [path.isAbsolute(PYTHON) ? path.dirname(path.dirname(PYTHON)) : "", "<python>"],
  [os.tmpdir(), "<tmp>"],
];

/** Log for people: no server paths, last 8 000 characters. */
export function cleanLog(log: string, workDir: string) {
  let out = log.split(workDir).join("<job>");
  for (const [p, label] of HIDE) if (p.length > 1) out = out.split(p).join(label);
  return out.length > LOG_MAX ? `…${out.slice(-LOG_MAX)}` : out;
}

/** web/worker/yellow.py (list / apply / preview), which reuses the engine's own helpers. */
export function yellowArgv(command: "list" | "apply" | "preview", ...paths: string[]): string[] {
  return ["-I", path.join(__dirname, "yellow.py"), `--engine=${ENGINE_DIR}`, command, ...paths];
}
