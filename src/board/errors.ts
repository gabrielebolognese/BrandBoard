import type { Tile } from "./geometry.js";

export type ClaimErrorCode =
  | "invalid_size"
  | "out_of_bounds"
  | "outside_universe"
  | "size_not_allowed_here"
  | "tile_conflict"
  | "empty_claim";

export abstract class ClaimError extends Error {
  abstract readonly code: ClaimErrorCode;
  abstract readonly status: number;
}

export class InvalidSizeError extends ClaimError {
  readonly code = "invalid_size";
  readonly status = 400;

  constructor(
    readonly size: number,
    readonly maxSize: number,
  ) {
    super(`Block size ${size} is not available. Blocks run from 1x1 to ${maxSize}x${maxSize}.`);
    this.name = "InvalidSizeError";
  }
}

export class OutOfBoundsError extends ClaimError {
  readonly code = "out_of_bounds";
  readonly status = 400;

  constructor(
    readonly x: number,
    readonly y: number,
    readonly size: number,
  ) {
    super(`A ${size}x${size} block at (${x}, ${y}) does not fit on the board.`);
    this.name = "OutOfBoundsError";
  }
}

/** In bounds on the square board, but out in the void beyond the last orbit. */
export class OutsideUniverseError extends ClaimError {
  readonly code = "outside_universe";
  readonly status = 400;

  constructor(
    readonly x: number,
    readonly y: number,
    readonly size: number,
  ) {
    super(`(${x}, ${y}) is outside the universe. Nothing out there is for sale.`);
    this.name = "OutsideUniverseError";
  }
}

/**
 * The planet fits on the board and inside the universe, and is still too big
 * for the ground it is standing on.
 */
export class SizeNotAllowedHereError extends ClaimError {
  readonly code = "size_not_allowed_here";
  readonly status = 400;

  constructor(
    readonly size: number,
    readonly cap: number,
    readonly where: string,
  ) {
    super(`${where} takes planets up to ${cap}x${cap}, and this one is ${size}x${size}.`);
    this.name = "SizeNotAllowedHereError";
  }
}

export class EmptyClaimError extends ClaimError {
  readonly code = "empty_claim";
  readonly status = 400;

  constructor() {
    super("A claim must contain at least one block.");
    this.name = "EmptyClaimError";
  }
}

/**
 * Someone else holds at least one of the requested tiles. Carries the offending
 * coordinates so the board can flash them red.
 *
 * The list is read back after the failed transaction has rolled back, so it is
 * a best-effort snapshot for the UI: by the time it is read, a tile could have
 * been freed or another one taken. Authority rests with the failed insert, not
 * with this list.
 */
export class TileConflictError extends ClaimError {
  readonly code = "tile_conflict";
  readonly status = 409;

  /**
   * conflicts is capped, because a large block can collide with thousands of
   * tiles and the 409 body has to stay a reasonable size. conflictCount is the
   * true total; conflicts is what the board needs in order to flash red.
   */
  constructor(
    readonly conflicts: readonly ConflictingTile[],
    readonly conflictCount: number = conflicts.length,
  ) {
    super(
      `${conflictCount} requested tile(s) are already taken: ` +
        conflicts
          .slice(0, 5)
          .map((t) => `(${t.x}, ${t.y})`)
          .join(", "),
    );
    this.name = "TileConflictError";
  }
}

export interface ConflictingTile extends Tile {
  /** The block holding it, when known. Null when only the key was reported. */
  readonly blockId: string | null;
}
