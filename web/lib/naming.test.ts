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
    expect(() => fileStem({ type: "OTHER", entity: "TMC", productName: "A" })).toThrow();
  });

  it("names a label <CODE>_LABEL_<file nr>_<product>_<batch>_<LANG> (Willem 20/10)", () => {
    const base = { type: "LABEL" as const, entity: "TMC" as const, productName: "Betaine AI test", batch: "BT-3877" };
    expect(fileStem({ ...base, fileNr: "840.S0850", language: "FR" })).toBe("TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_FR");
    expect(fileStem({ ...base, entity: "TMCGULF", language: "en" })).toBe("TMCGULF_LABEL_Betaine_AI_test_BT-3877_EN");
    expect(fileStem({ ...base, productName: "Sodium/Benzoate: 99%" })).toBe("TMC_LABEL_SodiumBenzoate_99_BT-3877");
    expect(fileStem({ ...base, fileNr: "###", language: "EN" })).toBe("TMC_LABEL_Betaine_AI_test_BT-3877_EN"); // no empty part
  });
});
