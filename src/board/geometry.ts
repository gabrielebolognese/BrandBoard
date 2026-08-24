import { BOARD_SIZE, MAX_BLOCK_SIZE, MIN_BLOCK_SIZE } from "../config.js";

export interface Tile {
  readonly x: number;
  readonly y: number;
}

export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * Any whole number of tiles from 1 to MAX_BLOCK_SIZE. There are no fixed price
 * tiers; the cap is an anti-monopoly rule, not a product list.
 */
export function isValidSize(size: number): boolean {
  return Number.isInteger(size) && size >= MIN_BLOCK_SIZE && size <= MAX_BLOCK_SIZE;
}

/**
 * A block is anchored at its top-left tile and occupies size x size tiles from
 * there, so the anchor alone is not enough: the far edge must also fit.
 * (98, 98) at size 3 would run to column 100, which does not exist.
 */
export function isInBounds(placement: Placement): boolean {
  const { x, y, size } = placement;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return x >= 0 && y >= 0 && x + size <= BOARD_SIZE && y + size <= BOARD_SIZE;
}

/**
 * Every tile a block covers, ordered by x then y.
 *
 * The ordering is load-bearing, not cosmetic: all tile inserts follow it, so
 * two transactions competing for the same square take index locks in the same
 * order and cannot deadlock. One of them simply loses on the unique key.
 */
export function tilesForBlock(placement: Placement): Tile[] {
  const { x, y, size } = placement;
  const tiles: Tile[] = [];
  for (let dx = 0; dx < size; dx += 1) {
    for (let dy = 0; dy < size; dy += 1) {
      tiles.push({ x: x + dx, y: y + dy });
    }
  }
  return tiles;
}

export function tileKey(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}

export function placementsOverlap(a: Placement, b: Placement): boolean {
  return (
    a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size
  );
}
