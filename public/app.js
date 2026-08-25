// FlashBrand board client.
//
// The board is one composite WebP plus a compact manifest, never ten thousand
// DOM nodes and never ten thousand image requests. Everything interactive is
// arithmetic against (x, y, size): there are no per-block event listeners.

import { createCheckout } from "./checkout.js";
import { getJson, postJson } from "./http.js";
import { createFeaturedColumn } from "./featured.js";

const BOARD = 100;

/**
 * Tile geometry, taken from the server so config.ts stays the single source.
 * TILE is the pitch; INSET is the ground around each square, so a tile's drawn
 * square is TILE - 2 * INSET across and neighbours never touch.
 */
let TILE = 24;
let INSET = 2;
let PX = BOARD * TILE;

const PLATFORM_LABEL = {
  x: "X",
  instagram: "IG",
  youtube: "YT",
  tiktok: "TT",
  twitch: "TW",
  newsletter: "NL",
};

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const viewport = document.getElementById("viewport");
const card = document.getElementById("card");
const badge = document.getElementById("badge");
const toastEl = document.getElementById("toast");

let blocks = [];
const owner = new Int16Array(BOARD * BOARD).fill(-1);
let held = new Uint8Array(BOARD * BOARD);

let composite = null;
let scale = 1;
let originX = 0;
let originY = 0;

let hoverTile = null;
let hoverBlock = -1;
let selection = null;
let flashes = [];
let dirty = true;

let rateCentsPerMonth = 0;
let priceIsPlaceholder = false;
let maxBlockSize = 25;

const detailCache = new Map();
let toastTimer = 0;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadStats() {
  const { ok, body: stats } = await getJson("/api/stats");
  if (!ok || stats === null) return;
  TILE = stats.tilePixels;
  INSET = stats.tileInset;
  PX = BOARD * TILE;
  rateCentsPerMonth = stats.pricePerTileCentsPerMonth;
  priceIsPlaceholder = stats.priceIsPlaceholder;
  maxBlockSize = stats.maxBlockSize;
  document.getElementById("stat-available").textContent = stats.tilesAvailable.toLocaleString();
  document.getElementById("stat-live").textContent = stats.blocksLive.toLocaleString();
  document.getElementById("stat-watching").textContent = stats.watching.toLocaleString();
}

async function loadManifest() {
  const { ok, body: manifest } = await getJson("/api/manifest");
  if (!ok || manifest === null) return;
  blocks = manifest.blocks;
  owner.fill(-1);
  blocks.forEach((block, i) => {
    for (let dx = 0; dx < block.size; dx += 1) {
      for (let dy = 0; dy < block.size; dy += 1) {
        owner[(block.y + dy) * BOARD + (block.x + dx)] = i;
      }
    }
  });
  dirty = true;
}

async function loadAvailability() {
  const { ok, body } = await getJson("/api/availability");
  if (!ok || body === null) return;
  const raw = atob(body.bits);
  const next = new Uint8Array(BOARD * BOARD);
  for (let i = 0; i < next.length; i += 1) {
    next[i] = (raw.charCodeAt(i >> 3) >> (i & 7)) & 1;
  }
  held = next;
  dirty = true;
}

function loadComposite() {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      composite = image;
      dirty = true;
      resolve();
    };
    image.onerror = () => resolve();
    image.src = "/board.webp";
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = viewport.getBoundingClientRect();
  // Backing store in device pixels, drawing in CSS pixels: without this the
  // board is soft on retina.
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

/**
 * Open at exactly 1:1. At any other scale the composite is resampled and the
 * one pixel tile borders go soft, which is the whole reason the grid looked
 * mushy before.
 */
function openingView() {
  const rect = viewport.getBoundingClientRect();
  scale = Math.max(1, minScale());
  originX = rect.width / 2 - (PX * scale) / 2;
  originY = rect.height / 2 - (PX * scale) / 2;
  dirty = true;
}

function minScale() {
  const rect = viewport.getBoundingClientRect();
  return Math.min(rect.width / PX, rect.height / PX) * 0.95;
}

function maxScale() {
  return 96 / TILE;
}

function clampView() {
  const rect = viewport.getBoundingClientRect();
  const span = PX * scale;
  const slackX = Math.max(60, rect.width * 0.35);
  const slackY = Math.max(60, rect.height * 0.35);
  originX = Math.min(Math.max(originX, rect.width - span - slackX), slackX);
  originY = Math.min(Math.max(originY, rect.height - span - slackY), slackY);
}

function toTile(cssX, cssY) {
  const bx = Math.floor((cssX - originX) / scale / TILE);
  const by = Math.floor((cssY - originY) / scale / TILE);
  if (bx < 0 || by < 0 || bx >= BOARD || by >= BOARD) return null;
  return { x: bx, y: by };
}

function isFree(square) {
  for (let dx = 0; dx < square.size; dx += 1) {
    for (let dy = 0; dy < square.size; dy += 1) {
      if (held[(square.y + dy) * BOARD + (square.x + dx)] === 1) return false;
    }
  }
  return !checkout.claims(square);
}

/** The square currently under the cursor: dragged size, or 1x1 when hovering. */
function currentSquare() {
  if (selection !== null) return selection.square;
  if (hoverTile === null) return null;
  return { x: hoverTile.x, y: hoverTile.y, size: 1 };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * A starfield in three layers, each panning at its own rate.
 *
 * The parallax is what turns a picture of space into a place: the far layer
 * barely moves while the near one tracks the board, so dragging feels like
 * travelling rather than sliding a poster around. Positions are in board
 * coordinates, generated once and padded past the edge so there is still sky
 * beyond the last orbit.
 */
const STAR_LAYERS = [
  { depth: 0.3, count: 320, minSize: 0.6, maxSize: 1.1, minAlpha: 0.16, maxAlpha: 0.45 },
  { depth: 0.58, count: 190, minSize: 0.8, maxSize: 1.5, minAlpha: 0.28, maxAlpha: 0.7 },
  { depth: 0.88, count: 90, minSize: 1.1, maxSize: 2.1, minAlpha: 0.45, maxAlpha: 1 },
];

const starLayers = STAR_LAYERS.map((layer) => ({ ...layer, stars: [] }));

/** Seeded, so the sky is the same on every load rather than reshuffling. */
function buildStars() {
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const pad = PX * 0.35;
  for (const layer of starLayers) {
    layer.stars = [];
    for (let i = 0; i < layer.count; i += 1) {
      layer.stars.push({
        x: -pad + random() * (PX + pad * 2),
        y: -pad + random() * (PX + pad * 2),
        size: layer.minSize + random() * (layer.maxSize - layer.minSize),
        alpha: layer.minAlpha + random() * (layer.maxAlpha - layer.minAlpha),
        phase: random() * Math.PI * 2,
        speed: 0.35 + random() * 1.15,
        warm: random() > 0.86,
      });
    }
  }
}

/**
 * Drawn over the board rather than under it, and skipped wherever a planet is.
 *
 * Painting them behind would mean an alpha channel on the composite, which cost
 * three quarters of a megabyte. Instead each star is projected back to the tile
 * it falls on and dropped if that tile is occupied, so a star never appears in
 * front of a world. The lookup is one array read against the index hit testing
 * already uses.
 */
function drawStars(rect, seconds) {
  for (const layer of starLayers) {
    for (const star of layer.stars) {
      const sx = originX * layer.depth + star.x * scale;
      if (sx < -4 || sx > rect.width + 4) continue;
      const sy = originY * layer.depth + star.y * scale;
      if (sy < -4 || sy > rect.height + 4) continue;

      const bx = Math.floor((sx - originX) / scale / TILE);
      const by = Math.floor((sy - originY) / scale / TILE);
      if (bx >= 0 && by >= 0 && bx < BOARD && by < BOARD && owner[by * BOARD + bx] !== -1) {
        continue;
      }

      const twinkle = 0.62 + 0.38 * Math.sin(seconds * star.speed + star.phase);
      ctx.globalAlpha = Math.min(1, star.alpha * twinkle);
      ctx.fillStyle = star.warm ? "#ffe6c8" : "#dce9ff";
      ctx.fillRect(sx, sy, star.size, star.size);
    }
  }
  ctx.globalAlpha = 1;
}

/** Screen rect of a square's footprint, matching the composite's insets. */
function rectFor(square) {
  const x = Math.round(originX + (square.x * TILE + INSET) * scale);
  const y = Math.round(originY + (square.y * TILE + INSET) * scale);
  const side = Math.round((square.size * TILE - 2 * INSET) * scale);
  return { x, y, side };
}

/** The planet inscribed in that footprint. */
function orbitOf(square) {
  const r = rectFor(square);
  return { cx: r.x + r.side / 2, cy: r.y + r.side / 2, radius: r.side / 2 };
}

function ring(square, color, width, glow = 0) {
  const { cx, cy, radius } = orbitOf(square);
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, radius - width / 2), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function disc(square, color) {
  const { cx, cy, radius } = orbitOf(square);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The tile grid, shown only while a claim is being placed.
 *
 * A universe with a grid painted permanently over it is just a spreadsheet, but
 * someone choosing where their planet goes needs to see the squares they are
 * choosing between. So it appears for the drag and then gets out of the way.
 */
function drawPlacementGrid(rect) {
  const step = TILE * scale;
  if (step < 6) return;

  ctx.save();
  ctx.strokeStyle = "rgba(120,160,220,0.13)";
  ctx.lineWidth = 1;
  ctx.beginPath();

  const top = Math.max(0, originY);
  const bottom = Math.min(rect.height, originY + PX * scale);
  const left = Math.max(0, originX);
  const right = Math.min(rect.width, originX + PX * scale);

  for (let i = 0; i <= BOARD; i += 1) {
    const x = Math.round(originX + i * step) + 0.5;
    if (x < -1 || x > rect.width + 1) continue;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let i = 0; i <= BOARD; i += 1) {
    const y = Math.round(originY + i * step) + 0.5;
    if (y < -1 || y > rect.height + 1) continue;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }

  ctx.stroke();
  ctx.restore();
}

function draw() {
  const rect = viewport.getBoundingClientRect();
  const seconds = performance.now() / 1000;

  // The void, the sky the server drew, then the stars that move.
  ctx.fillStyle = "#01020a";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (composite !== null) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      composite,
      Math.round(originX),
      Math.round(originY),
      Math.round(PX * scale),
      Math.round(PX * scale),
    );
  }

  drawStars(rect, seconds);
  if (selection !== null) drawPlacementGrid(rect);

  drawClaimedOrbits(seconds);

  const square = currentSquare();
  if (selection === null && hoverBlock >= 0) {
    // A slow breath around the planet under the cursor, so hovering reads as
    // catching the light rather than switching an outline on.
    const pulse = 0.55 + 0.45 * Math.sin(seconds * 2.2);
    ring(blocks[hoverBlock], `rgba(190,220,255,${(0.55 + 0.35 * pulse).toFixed(3)})`, 2, 18 * pulse);
  } else if (square !== null) {
    const free = isFree(square);
    disc(square, free ? "rgba(74,222,128,0.16)" : "rgba(242,84,91,0.18)");
    ring(square, free ? "#4ade80" : "#f2545b", 2, 14);

    // The square of tiles the planet actually occupies, so the size being
    // bought is never a guess.
    ctx.save();
    ctx.strokeStyle = free ? "rgba(74,222,128,0.34)" : "rgba(242,84,91,0.34)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    const r = rectFor(square);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.side - 1, r.side - 1);
    ctx.restore();
  }

  for (const item of checkout.pending()) {
    disc(item, "rgba(96,165,250,0.18)");
    ring(item, "#60a5fa", 2, 12);
  }

  drawFlashes();
  dirty = false;
}

/**
 * Orbits that are held but have no planet in them yet: someone's reservation,
 * or a listing waiting on review. They are not in the composite, so without
 * this they would look like empty space and be claimed again.
 */
function drawClaimedOrbits(seconds) {
  const pulse = 0.5 + 0.5 * Math.sin(seconds * 1.6);
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.lineDashOffset = -seconds * 12;
  ctx.strokeStyle = `rgba(245,180,80,${(0.45 + 0.3 * pulse).toFixed(3)})`;
  ctx.lineWidth = 1.5;

  for (let i = 0; i < held.length; i += 1) {
    if (held[i] === 0 || owner[i] !== -1) continue;
    const x = i % BOARD;
    const { cx, cy, radius } = orbitOf({ x, y: (i - x) / BOARD, size: 1 });
    if (cx < -radius || cy < -radius) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** A shockwave that expands as it fades, so an arrival is felt, not just seen. */
function drawFlashes() {
  const now = performance.now();
  flashes = flashes.filter((flash) => now - flash.born < 1400);
  for (const flash of flashes) {
    const life = 1 - (now - flash.born) / 1400;
    const rgb = flash.kind === "ok" ? "74,222,128" : "242,84,91";
    const { cx, cy, radius } = orbitOf(flash);

    ctx.save();
    ctx.strokeStyle = `rgba(${rgb},${life.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius) * (1 + (1 - life) * 1.6), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    disc(flash, `rgba(${rgb},${(life * 0.35).toFixed(3)})`);
  }
}

/** The sky moves whether or not anything was clicked, so this always draws. */
function frame() {
  draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Badge and card
// ---------------------------------------------------------------------------

function showBadge(square, clientX, clientY) {
  const free = isFree(square);
  // Display only, and it works for any size because it is derived from the
  // per-tile rate rather than a fixed list of purchasable sizes.
  const tiles = square.size * square.size;
  const amount = ((tiles * rateCentsPerMonth) / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  const capped = square.size >= maxBlockSize ? " &middot; max" : "";
  badge.innerHTML =
    `${square.size}x${square.size} <small>${amount}/mo` +
    `${priceIsPlaceholder ? "*" : ""}${capped}</small>`;
  badge.className = free ? "badge" : "badge blocked";
  badge.hidden = false;
  badge.style.left = `${Math.min(clientX + 16, window.innerWidth - 120)}px`;
  badge.style.top = `${Math.max(clientY - 34, 8)}px`;
}

function hideBadge() {
  badge.hidden = true;
}

function showCard(block, clientX, clientY) {
  // The avatar is cropped straight out of the composite, so hovering costs no
  // extra image request.
  const k = 52 / (block.size * TILE);
  const avatar = document.getElementById("card-avatar");
  avatar.style.backgroundSize = `${PX * k}px ${PX * k}px`;
  avatar.style.backgroundPosition = `${-block.x * TILE * k}px ${-block.y * TILE * k}px`;

  document.getElementById("card-name").textContent = block.name;
  document.getElementById("card-handle").textContent = `@${block.handle}`;

  const links = document.getElementById("card-links");
  links.textContent = "";
  const cached = detailCache.get(block.id);
  if (cached !== undefined) {
    for (const platform of Object.keys(cached.links ?? {})) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = PLATFORM_LABEL[platform] ?? platform.slice(0, 2).toUpperCase();
      links.append(pill);
    }
    if (cached.category) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = cached.category;
      links.append(pill);
    }
  } else {
    void getJson(`/api/block/${block.id}`).then(({ ok, body: detail }) => {
      if (!ok || detail === null) return;
      detailCache.set(block.id, detail);
      if (hoverBlock >= 0 && blocks[hoverBlock]?.id === block.id) {
        showCard(block, clientX, clientY);
      }
    });
  }

  card.hidden = false;
  card.style.left = `${Math.min(clientX + 18, window.innerWidth - 266)}px`;
  card.style.top = `${Math.min(clientY + 16, window.innerHeight - 100)}px`;
}

function hideCard() {
  card.hidden = true;
}

function toast(message, kind) {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 4200);
}

// ---------------------------------------------------------------------------
// Pointer: drag on free space sizes a block, drag elsewhere pans
// ---------------------------------------------------------------------------

let panning = null;

canvas.addEventListener("pointerdown", (event) => {
  const rect = viewport.getBoundingClientRect();
  const tile = toTile(event.clientX - rect.left, event.clientY - rect.top);
  canvas.setPointerCapture(event.pointerId);

  const wantsPan =
    event.button === 1 ||
    event.shiftKey ||
    tile === null ||
    held[tile.y * BOARD + tile.x] === 1;

  if (wantsPan) {
    panning = { x: event.clientX, y: event.clientY, moved: 0 };
    canvas.classList.add("panning");
    hideBadge();
    return;
  }

  // Free space: this drag chooses the size of the block.
  selection = { anchor: tile, square: { x: tile.x, y: tile.y, size: 1 } };
  hideCard();
  showBadge(selection.square, event.clientX, event.clientY);
  dirty = true;
});

canvas.addEventListener("pointermove", (event) => {
  const rect = viewport.getBoundingClientRect();
  const cssX = event.clientX - rect.left;
  const cssY = event.clientY - rect.top;

  if (panning !== null) {
    const dx = event.clientX - panning.x;
    const dy = event.clientY - panning.y;
    panning.moved += Math.abs(dx) + Math.abs(dy);
    panning.x = event.clientX;
    panning.y = event.clientY;
    originX += dx;
    originY += dy;
    clampView();
    hideCard();
    dirty = true;
    return;
  }

  if (selection !== null) {
    const tile = toTile(cssX, cssY);
    if (tile !== null) {
      selection.square = squareFromDrag(selection.anchor, tile);
      showBadge(selection.square, event.clientX, event.clientY);
      dirty = true;
    }
    return;
  }

  hoverTile = toTile(cssX, cssY);
  const previous = hoverBlock;
  hoverBlock = hoverTile === null ? -1 : owner[hoverTile.y * BOARD + hoverTile.x];

  if (hoverBlock >= 0) {
    showCard(blocks[hoverBlock], event.clientX, event.clientY);
    hideBadge();
  } else {
    if (previous >= 0) hideCard();
    const square = currentSquare();
    if (square !== null) showBadge(square, event.clientX, event.clientY);
    else hideBadge();
  }
  dirty = true;
});

canvas.addEventListener("pointerup", (event) => {
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

  if (panning !== null) {
    const moved = panning.moved;
    panning = null;
    canvas.classList.remove("panning");
    if (moved <= 6 && hoverBlock >= 0) {
      window.open(blocks[hoverBlock].url, "_blank", "noopener,noreferrer");
    }
    return;
  }

  if (selection === null) return;
  const square = selection.square;
  selection = null;
  hideBadge();
  dirty = true;

  if (!isFree(square)) {
    const why = checkout.claims(square) ? "already in your order" : "already taken";
    toast("That orbit is " + why + ".", "bad");
    return;
  }
  checkout.add(square);
  dirty = true;
});

canvas.addEventListener("pointerleave", () => {
  hoverTile = null;
  hoverBlock = -1;
  hideCard();
  hideBadge();
  dirty = true;
});

/**
 * Drag distance picks the size, up to the anti-monopoly cap, and the square
 * stays on the board.
 */
function squareFromDrag(anchor, current) {
  const dx = current.x - anchor.x;
  const dy = current.y - anchor.y;
  const size = Math.min(maxBlockSize, Math.max(Math.abs(dx), Math.abs(dy)) + 1);
  let x = dx < 0 ? anchor.x - (size - 1) : anchor.x;
  let y = dy < 0 ? anchor.y - (size - 1) : anchor.y;
  x = Math.min(Math.max(x, 0), BOARD - size);
  y = Math.min(Math.max(y, 0), BOARD - size);
  return { x, y, size };
}

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;

    const factor = Math.exp(-event.deltaY * 0.0016);
    const next = Math.min(Math.max(scale * factor, minScale()), maxScale());
    // Zoom about the cursor, so the tile under it stays under it.
    originX = cssX - ((cssX - originX) * next) / scale;
    originY = cssY - ((cssY - originY) * next) / scale;
    scale = next;

    clampView();
    hoverTile = toTile(cssX, cssY);
    hoverBlock = hoverTile === null ? -1 : owner[hoverTile.y * BOARD + hoverTile.x];
    hideCard();
    dirty = true;
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.querySelector(".dev")?.addEventListener("click", async (event) => {
  const action = event.target.dataset?.action;
  if (action === undefined) return;

  if (action === "sweep") {
    const { ok, body: result } = await postJson("/api/sweep");
    if (!ok || result === null) {
      toast("The sweep could not be run.", "bad");
      return;
    }
    toast(
      `Swept ${result.expiredBlockIds.length} lapsed reservation(s), freed ${result.releasedTiles} tile(s).`,
      "ok",
    );
    await Promise.all([loadAvailability(), loadStats()]);
    return;
  }

  if (action === "reset") {
    await postJson("/api/reset");
    checkout.clear();
    toast("Board emptied. Restart the server to reseed.", "ok");
    await Promise.all([loadManifest(), loadAvailability(), loadStats(), loadComposite()]);
    await featured.refresh();
  }
});

window.addEventListener("resize", () => {
  resize();
  clampView();
  featured.repaint();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Stats first: it carries the tile size every coordinate calculation depends on.
await loadStats();
buildStars();

const featured = createFeaturedColumn({
  listEl: document.getElementById("featured-list"),
  buyEl: document.getElementById("featured-buy"),
  geometry: () => ({ tile: TILE, px: PX }),
  liveBlocks: () => blocks,
  onPurchase: () => {
    dirty = true;
  },
});

const checkout = createCheckout({
  rate: () => ({ cents: rateCentsPerMonth, placeholder: priceIsPlaceholder }),
  onChange: () => {
    dirty = true;
  },
  onReserved: async () => {
    await Promise.all([loadAvailability(), loadStats()]);
    dirty = true;
  },
  onConflict: (body) => {
    for (const tile of body.conflicts ?? []) {
      flashes.push({ x: tile.x, y: tile.y, size: 1, kind: "bad", born: performance.now() });
    }
    toast(body.message ?? "Someone claimed one of those squares first.", "bad");
    void loadAvailability();
  },
});
resize();
openingView();
requestAnimationFrame(frame);

void loadComposite();
void Promise.all([
  loadManifest().then(() => featured.refresh()),
  loadAvailability(),
  featured.loadPricing(),
]);

// The watching count is server state that drifts once a minute, so poll for it
// rather than inventing a number per browser.
setInterval(() => {
  loadStats().catch(() => {
    // A blip in the stats poll is not worth surfacing; the next tick retries.
  });
}, 20_000);
