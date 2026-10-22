import { describe, expect, it } from "vitest";
import { CHANGES_MARK, changeWarnings, parseChanges } from "./changes";

describe("change warnings of on-screen edits (Willem 19/10)", () => {
  it("reads the warnings back from the log of a finalise attempt", () => {
    const log = ["[worker] something", CHANGES_MARK + JSON.stringify([{ before: "Assay 99.6", after: "Assay 99.9", unknown: ["99.9"] }]), "stays"].join("\n");
    expect(changeWarnings(log)).toEqual([{ before: "Assay 99.6", after: "Assay 99.9", unknown: ["99.9"] }]);
  });

  it("no mark, or a damaged line: no warnings", () => {
    expect(changeWarnings("[worker] 2 yellow part(s) still marked")).toBeNull();
    expect(changeWarnings(CHANGES_MARK + "{not json")).toBeNull();
    expect(changeWarnings(null)).toBeNull();
  });

  it("caps sizes and drops anything that is not text", () => {
    const [c] = parseChanges(JSON.stringify([{ before: "x".repeat(900), after: 5, unknown: ["ok", 7, "y".repeat(100)] }]));
    expect(c.before).toHaveLength(500);
    expect(c.after).toBe("");
    expect(c.unknown).toEqual(["ok", "y".repeat(60)]);
    expect(() => parseChanges("{}")).toThrow();
  });
});
