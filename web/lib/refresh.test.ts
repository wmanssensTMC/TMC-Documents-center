import { describe, expect, it } from "vitest";
import { refreshStep, SLOWER_AFTER_MS, STOP_AFTER_MS } from "./refresh";

const MIN = 60 * 1000;

describe("refreshStep: jobs page auto-refresh (26/10/2026, first live run)", () => {
  it("reloads every `seconds` during the first two minutes", () => {
    expect(refreshStep(10_000, 10, true)).toEqual({ refresh: true, nextMs: 10_000 });
    expect(refreshStep(SLOWER_AFTER_MS, 10, true)).toEqual({ refresh: true, nextMs: 10_000 });
  });

  it("slows to 30 seconds after two minutes", () => {
    expect(refreshStep(SLOWER_AFTER_MS + 1, 10, true)).toEqual({ refresh: true, nextMs: 30_000 });
    expect(refreshStep(20 * MIN, 10, true)?.nextMs).toBe(30_000);
  });

  it("never speeds up a page that already asks for more than 30 seconds", () => {
    expect(refreshStep(SLOWER_AFTER_MS + 1, 60, true)?.nextMs).toBe(60_000);
  });

  it("does not reload while the tab is hidden, but keeps the timer going", () => {
    expect(refreshStep(10_000, 10, false)).toEqual({ refresh: false, nextMs: 10_000 });
    expect(refreshStep(5 * MIN, 10, false)).toEqual({ refresh: false, nextMs: 30_000 });
  });

  it("still runs at exactly 30 minutes and stops for good after that", () => {
    expect(refreshStep(STOP_AFTER_MS, 10, true)).not.toBeNull();
    expect(refreshStep(STOP_AFTER_MS + 1, 10, true)).toBeNull();
    expect(refreshStep(STOP_AFTER_MS + 1, 10, false)).toBeNull();
  });

  it("over 30 minutes a 10 s page makes about 70 reloads, not 180", () => {
    // Walk the same loop the component runs: first tick after `seconds`, then nextMs each time.
    let age = 10_000;
    let reloads = 0;
    for (let step = refreshStep(age, 10, true); step; step = refreshStep(age, 10, true)) {
      if (step.refresh) reloads++;
      age += step.nextMs;
    }
    expect(reloads).toBe(12 + 56); // 12 ticks up to 2 min, then one per 30 s up to 30 min
  });
});
