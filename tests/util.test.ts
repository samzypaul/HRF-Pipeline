import { describe, expect, it } from "vitest";
import { createLimiter, mapLimit, sleep } from "../src/lib/util";

describe("mapLimit", () => {
  it("never runs more than the limit at once and visits every item", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      seen.push(n);
      active--;
    });
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("stops starting new items after a failure, finishes the running ones, then throws the first error", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
        started.push(n);
        await sleep(5);
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(8);
  });

  it("handles an empty list", async () => {
    await expect(mapLimit([], 4, async () => undefined)).resolves.toBeUndefined();
  });
});

describe("createLimiter", () => {
  it("caps calls in flight and returns each result", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(5);
          active--;
          return n * 2;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });

  it("frees its slot when a call fails", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });
});
