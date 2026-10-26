import { describe as group, expect, it } from "vitest";
import { describe } from "./describe";

group("worker error text", () => {
  it("shows the database's own reason behind 'Failed query'", () => {
    const err = new Error("Failed query: update jobs", { cause: new Error("password authentication failed for user x") });
    expect(describe(err)).toBe("Failed query: update jobs <- password authentication failed for user x");
  });

  it("never shows a database address or its password", () => {
    const err = new Error("connect failed", { cause: new Error("bad url postgresql://u:secret@host/db?sslmode=require") });
    const text = describe(err);
    expect(text).not.toContain("secret");
    expect(text).toContain("postgresql://[hidden]");
  });

  it("handles a plain value", () => {
    expect(describe("oops")).toBe("oops");
  });
});
