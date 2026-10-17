import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileStem, type NameParts } from "./naming";

// Shared with engine/tests/test_naming_parity.py, so both sides give the same names.
const cases: (NameParts & { expected: string })[] = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../engine/tests/naming_cases.json"), "utf8"),
);

describe("fileStem (BRIEF 7.5, same as engine)", () => {
  it.each(cases)("$type $productName -> $expected", ({ expected, ...parts }) => {
    expect(fileStem(parts)).toBe(expected);
  });

  it("refuses types without a naming rule", () => {
    expect(() => fileStem({ type: "LABEL", entity: "TMC", productName: "A" })).toThrow();
    expect(() => fileStem({ type: "OTHER", entity: "TMC", productName: "A" })).toThrow();
  });
});
