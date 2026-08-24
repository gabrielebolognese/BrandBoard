import { describe, expect, it } from "vitest";
import { BOARD_SIZE, MAX_BLOCK_SIZE } from "../config.js";
import { isInBounds, isValidSize, placementsOverlap, tilesForBlock } from "./geometry.js";

describe("bounds", () => {
  it("rejects a size 3 block at (98, 98) because it would run off the board", () => {
    expect(isInBounds({ x: 98, y: 98, size: 3 })).toBe(false);
  });

  it("accepts the same square where it does fit", () => {
    expect(isInBounds({ x: 97, y: 97, size: 3 })).toBe(true);
  });

  it("accepts a 1x1 in the last tile and rejects the one past it", () => {
    expect(isInBounds({ x: BOARD_SIZE - 1, y: BOARD_SIZE - 1, size: 1 })).toBe(true);
    expect(isInBounds({ x: BOARD_SIZE, y: 0, size: 1 })).toBe(false);
  });

  it("rejects negative and non-integer anchors", () => {
    expect(isInBounds({ x: -1, y: 0, size: 1 })).toBe(false);
    expect(isInBounds({ x: 1.5, y: 0, size: 1 })).toBe(false);
  });

  it("accepts any whole size from 1x1 up to the cap", () => {
    expect([0, 2.5, -1, MAX_BLOCK_SIZE + 1, BOARD_SIZE].every((size) => !isValidSize(size))).toBe(
      true,
    );
    expect([1, 2, 5, 6, 17, MAX_BLOCK_SIZE].every(isValidSize)).toBe(true);
  });

  it("caps blocks at 25x25 so nobody can corner the board", () => {
    expect(MAX_BLOCK_SIZE).toBe(25);
    // 625 tiles, 6.25% of the board.
    expect(MAX_BLOCK_SIZE * MAX_BLOCK_SIZE).toBe(625);
    expect(isValidSize(26)).toBe(false);
  });

  it("still requires a legal square to fit inside the board", () => {
    expect(isInBounds({ x: 40, y: 40, size: 20 })).toBe(true);
    expect(isInBounds({ x: 90, y: 0, size: 11 })).toBe(false);
  });
});

describe("tilesForBlock", () => {
  it("covers size squared tiles", () => {
    expect(tilesForBlock({ x: 0, y: 0, size: 1 })).toHaveLength(1);
    expect(tilesForBlock({ x: 4, y: 7, size: 5 })).toHaveLength(25);
  });

  it("anchors at the top-left tile", () => {
    expect(tilesForBlock({ x: 2, y: 3, size: 2 })).toEqual([
      { x: 2, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 3 },
      { x: 3, y: 4 },
    ]);
  });

  it("emits tiles in a stable order, which is what keeps concurrent claims from deadlocking", () => {
    const tiles = tilesForBlock({ x: 10, y: 10, size: 3 });
    const sorted = [...tiles].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    expect(tiles).toEqual(sorted);
  });
});

describe("placementsOverlap", () => {
  it("detects a partial overlap", () => {
    expect(placementsOverlap({ x: 0, y: 0, size: 2 }, { x: 1, y: 1, size: 2 })).toBe(true);
  });

  it("treats edge-adjacent blocks as free of each other", () => {
    expect(placementsOverlap({ x: 0, y: 0, size: 2 }, { x: 2, y: 0, size: 2 })).toBe(false);
  });

  it("does not require size alignment: blocks may sit at any free anchor", () => {
    expect(placementsOverlap({ x: 3, y: 7, size: 3 }, { x: 6, y: 7, size: 2 })).toBe(false);
  });
});
