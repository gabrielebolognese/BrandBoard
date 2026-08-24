/**
 * The "currently watching" number on the board.
 *
 * It is deliberately server state rather than something each browser makes up,
 * so every visitor sees the same figure. It drifts once a minute instead of
 * ticking continuously, which is how a real presence count behaves.
 *
 * In production this belongs in Redis or a row in the database so every
 * instance agrees; a module-level value is only correct while there is one
 * process serving the board.
 */

const START = 300;
const FLOOR = 195;
const CEILING = 565;
const MIN_STEP = 5;
const MAX_STEP = 20;
const TICK_MS = 60_000;

let watching = START;
let timer: NodeJS.Timeout | null = null;

export function currentlyWatching(): number {
  return watching;
}

/**
 * One minute's drift: between 5 and 20 viewers, up or down. A step that would
 * leave the range is reflected back inside it rather than clamped, so the
 * number keeps moving instead of sticking to a bound.
 */
export function stepWatching(): number {
  const magnitude = MIN_STEP + Math.floor(Math.random() * (MAX_STEP - MIN_STEP + 1));
  const up = Math.random() < 0.5;
  const next = up ? watching + magnitude : watching - magnitude;

  watching = next > CEILING || next < FLOOR ? (up ? watching - magnitude : watching + magnitude) : next;
  watching = Math.min(Math.max(watching, FLOOR), CEILING);
  return watching;
}

export function startWatchingTicker(): void {
  if (timer !== null) return;
  timer = setInterval(stepWatching, TICK_MS);
  timer.unref();
}

/** Test seam: put the counter back to a known state. */
export function resetWatching(value = START): void {
  watching = value;
}
