// Runs the existing Python engine (engine/scripts/neutralize.py) unchanged. Its provenance gate
// and yellow review run inside it; nothing here can switch them off.
//
// Safety (security review N2/N3): an argument list, never a shell; values passed as
// --option=value so text starting with "-" cannot become an option; the engine gets no secrets
// (no database or storage keys in its environment); the log is capped and stripped of paths.
import { execFile } from "node:child_process";
import path from "node:path";

export const ENGINE_DIR = process.env.ENGINE_DIR ?? path.resolve(__dirname, "..", "..", "engine");
const PYTHON = process.env.ENGINE_PYTHON ?? "python3";
const TIMEOUT_MS = 10 * 60 * 1000;
const LOG_MAX = 8000;

export type EngineRun = { code: number; log: string };

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

export function runPython(argv: string[], workDir: string): Promise<EngineRun> {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workDir,
    TMPDIR: workDir,
    LANG: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
  } as unknown as NodeJS.ProcessEnv; // only these: the engine gets no secrets
  return new Promise((resolve) => {
    execFile(PYTHON, argv, { cwd: workDir, env, timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      const code = !e ? 0 : typeof e.code === "number" ? e.code : 1;
      let log = `${stdout}\n${stderr}`;
      if (e?.killed) log += "\n[worker] stopped: the run took longer than 10 minutes";
      else if (e && typeof e.code !== "number") log += `\n[worker] could not start the engine (${e.code ?? e.message})`;
      resolve({ code, log: cleanLog(log, workDir) });
    });
  });
}

/** Log for people: no server paths, last 8 000 characters. */
export function cleanLog(log: string, workDir: string) {
  const out = log.split(workDir).join("<job>").split(ENGINE_DIR).join("<engine>");
  return out.length > LOG_MAX ? `…${out.slice(-LOG_MAX)}` : out;
}
