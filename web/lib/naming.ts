// File names (BRIEF 7.5), a 1:1 port of the engine so library uploads and engine output
// get the same name. Keep in sync with:
//   COA      engine/scripts/neutralize_docx.py      make_output_stem()  (parts cut at 40)
//   MSDS     engine/scripts/neutralize_sds_docx.py  _safe()             (cut at 60)
//   TDS/SPEC engine/scripts/tmc_common.py           safe_part()         (cut at 80)
// A part that is not known is left out, never invented.
import type { DocType, Entity } from "./constants";

export type NameParts = {
  type: DocType;
  entity: Entity;
  productName?: string | null;
  fileNr?: string | null;
  batch?: string | null;
  /** Used only for a COA without file nr, product and batch (engine: source file stem). */
  fallbackStem?: string | null;
};

/** Types that have a settled naming rule. LABEL and OTHER have none yet (ask Willem). */
export const NAMED_TYPES = ["COA", "MSDS", "TDS", "SPEC"] as const satisfies readonly DocType[];

// Python's [^\w\s\-.] with Unicode \w (letters, digits, underscore).
const NOT_WORD = /[^\p{L}\p{N}_\s\-.]/gu;

function cut(s: string, n: number) {
  return Array.from(s).slice(0, n).join(""); // code points, like Python slicing
}

function coaSanitize(s: string | null | undefined) {
  const t = (s ?? "").trim().replace(NOT_WORD, "").replace(/\s+/gu, "_");
  return cut(t, 40);
}

function msdsSafe(s: string | null | undefined) {
  const t = (s ?? "").trim().replace(NOT_WORD, "");
  return cut(t.replace(/\s+/gu, "_"), 60);
}

function safePart(s: string | null | undefined) {
  const t = String(s ?? "").trim().replace(/[\\/:*?"<>|]/g, "");
  return cut(t.replace(/\s+/gu, "_"), 80);
}

export function fileStem(p: NameParts): string {
  const code = p.entity || "TMC";
  switch (p.type) {
    case "COA": {
      const parts = [code, "COA"];
      if (p.fileNr) parts.push(coaSanitize(p.fileNr));
      if (p.productName) parts.push(coaSanitize(p.productName));
      if (p.batch) parts.push(coaSanitize(p.batch));
      if (parts.length === 2 && p.fallbackStem) parts.push(coaSanitize(p.fallbackStem));
      return parts.join("_");
    }
    case "MSDS":
      return `${code}_MSDS_${msdsSafe(p.productName)}`;
    case "TDS":
    case "SPEC": // spec sheets go the TDS way (ENGINE.md, Willem 15/10)
      return [code, "TDS", safePart(p.productName)].filter(Boolean).join("_");
    default:
      throw new Error(`No file name rule for type ${p.type}`);
  }
}
