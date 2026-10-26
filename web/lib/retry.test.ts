import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twice } from "./retry";

// Storage or database waking up after a quiet spell (26/10/2026, first live run).
describe("twice: one retry after a short pause", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the first result without a second call", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(twice(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the second call after one transient failure", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("cold start")).mockResolvedValueOnce("ok");
    const p = twice(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("waits 800 ms before the retry, not earlier", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("cold start")).mockResolvedValueOnce("ok");
    const p = twice(fn);
    await vi.advanceTimersByTimeAsync(799);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second failure with the second error, no third call", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(new Error("second"));
    const p = twice(fn);
    const settled = expect(p).rejects.toThrow("second");
    await vi.runAllTimersAsync();
    await settled;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 'nothing found' answer (null is a result, not a failure)", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    await expect(twice(fn)).resolves.toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a synchronous throw as well", async () => {
    const fn = vi.fn(() => {
      if (fn.mock.calls.length === 1) throw new Error("sync");
      return Promise.resolve(42);
    });
    const p = twice(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe(42);
  });
});
