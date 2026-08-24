import { beforeEach, describe, expect, it } from "vitest";
import { currentlyWatching, resetWatching, stepWatching } from "./watching.js";

describe("currently watching", () => {
  beforeEach(() => {
    resetWatching();
  });

  it("starts at 300", () => {
    expect(currentlyWatching()).toBe(300);
  });

  it("moves by between 5 and 20 on every step", () => {
    for (let i = 0; i < 2000; i += 1) {
      const before = currentlyWatching();
      const after = stepWatching();
      const delta = Math.abs(after - before);
      expect(delta).toBeGreaterThanOrEqual(5);
      expect(delta).toBeLessThanOrEqual(20);
    }
  });

  it("never leaves 195..565, however long it runs", () => {
    for (let i = 0; i < 20_000; i += 1) {
      const value = stepWatching();
      expect(value).toBeGreaterThanOrEqual(195);
      expect(value).toBeLessThanOrEqual(565);
    }
  });

  it("reaches both ends of the range rather than hovering near the start", () => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 20_000; i += 1) {
      const value = stepWatching();
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    // A reflecting step should explore the whole band, not stall at a bound.
    expect(low).toBeLessThan(230);
    expect(high).toBeGreaterThan(530);
  });
});
