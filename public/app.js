// FlashBrand board client.
//
// The board is one composite WebP plus a compact manifest, never ten thousand
// DOM nodes and never ten thousand image requests. Everything interactive is
// arithmetic against (x, y, size): there are no per-block event listeners.

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
const featuredEl = document.getElementById("featured");

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

/** Squares chosen but not yet reserved. One checkout can cover several. */
let cart = [];
/** Set once the cart has been reserved and priced by the server. */
let checkoutSession = null;
let holdTimer = 0;

const detailCache = new Map();
let featuredBlocks = [];
let toastTimer = 0;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadStats() {
  const stats = await (await fetch("/api/stats")).json();
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
  const manifest = await (await fetch("/api/manifest")).json();
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
  const { bits } = await (await fetch("/api/availability")).json();
  const raw = atob(bits);
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
// Featured column
// ---------------------------------------------------------------------------

async function loadFeatured() {
  const { blocks: rows } = await (await fetch("/api/featured")).json();
  featuredBlocks = rows;
  featuredEl.textContent = "";

  for (const block of rows) {
    const cell = document.createElement("div");
    cell.className = "feat";
    cell.title = `${block.name} @${block.handle}`;

    const label = document.createElement("div");
    label.className = "feat-label";
    label.textContent = block.name;
    cell.append(label);

    cell.addEventListener("click", () => {
      window.open(block.url, "_blank", "noopener,noreferrer");
    });
    featuredEl.append(cell);
  }
  paintFeatured();
}

/**
 * Each featured cell is a crop of the composite, so the column costs no extra
 * image requests. The crop depends on the rendered size, so it is recomputed
 * whenever the column is laid out.
 */
function paintFeatured() {
  const cells = featuredEl.children;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    const block = featuredBlocks[i];
    if (block === undefined) continue;
    const side = cell.clientWidth;
    if (side === 0) continue;
    const k = side / (block.size * TILE);
    cell.style.backgroundSize = `${PX * k}px ${PX * k}px`;
    cell.style.backgroundPosition = `${-block.x * TILE * k}px ${-block.y * TILE * k}px`;
  }
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
  return !overlapsCart(square);
}

/** A square already in the cart is spoken for, even though nobody holds it yet. */
function overlapsCart(square, ignore = -1) {
  return cart.some(
    (item, i) =>
      i !== ignore &&
      square.x < item.x + item.size &&
      item.x < square.x + square.size &&
      square.y < item.y + item.size &&
      item.y < square.y + square.size,
  );
}

function money(cents) {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
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

function draw() {
  const rect = viewport.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#0d1015";
  ctx.fillRect(0, 0, rect.width, rect.height);

  if (composite !== null) {
    // One drawImage for the entire board. Snapped to whole pixels and with
    // smoothing off at or above 1:1, so tile borders stay exactly one pixel.
    ctx.imageSmoothingEnabled = scale < 0.98;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      composite,
      Math.round(originX),
      Math.round(originY),
      Math.round(PX * scale),
      Math.round(PX * scale),
    );
  }

  drawReservedTiles();

  const square = currentSquare();
  if (selection === null && hoverBlock >= 0) {
    outline(blocks[hoverBlock], "rgba(255,255,255,0.92)", 2);
  } else if (square !== null) {
    const free = isFree(square);
    fill(square, free ? "rgba(74,222,128,0.22)" : "rgba(242,84,91,0.22)");
    outline(square, free ? "#4ade80" : "#f2545b", 2);
  }

  for (const item of cart) {
    fill(item, "rgba(96,165,250,0.24)");
    outline(item, "#60a5fa", 2);
  }

  drawFlashes();
  dirty = false;
}

/**
 * Tiles that are held but have no live block: someone's reservation, or a
 * listing waiting on review. They are not in the composite, so without this
 * they would look free.
 */
function drawReservedTiles() {
  ctx.fillStyle = "rgba(245,180,80,0.42)";
  for (let i = 0; i < held.length; i += 1) {
    if (held[i] === 0 || owner[i] !== -1) continue;
    const x = i % BOARD;
    const r = rectFor({ x, y: (i - x) / BOARD, size: 1 });
    ctx.fillRect(r.x, r.y, r.side, r.side);
  }
}

function drawFlashes() {
  const now = performance.now();
  flashes = flashes.filter((flash) => now - flash.born < 1100);
  for (const flash of flashes) {
    const life = 1 - (now - flash.born) / 1100;
    const rgb = flash.kind === "ok" ? "74,222,128" : "242,84,91";
    fill(flash, `rgba(${rgb},${(life * 0.5).toFixed(3)})`);
    outline(flash, `rgba(${rgb},${life.toFixed(3)})`, 2);
  }
}

/** Screen rect of a square's drawn area, matching the composite's insets. */
function rectFor(square) {
  const x = Math.round(originX + (square.x * TILE + INSET) * scale);
  const y = Math.round(originY + (square.y * TILE + INSET) * scale);
  const side = Math.round((square.size * TILE - 2 * INSET) * scale);
  return { x, y, side };
}

function fill(square, color) {
  const r = rectFor(square);
  ctx.fillStyle = color;
  ctx.fillRect(r.x, r.y, r.side, r.side);
}

function outline(square, color, width) {
  const r = rectFor(square);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.side - width, r.side - width);
}

function frame() {
  if (dirty || flashes.length > 0) draw();
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
    fetch(`/api/block/${block.id}`)
      .then((r) => r.json())
      .then((detail) => {
        detailCache.set(block.id, detail);
        if (hoverBlock >= 0 && blocks[hoverBlock]?.id === block.id) {
          showCard(block, clientX, clientY);
        }
      })
      .catch(() => {});
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
  canvas.releasePointerCapture(event.pointerId);

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
    const why = overlapsCart(square) ? "already in your cart" : "already taken";
    toast("That square is " + why + ".", "bad");
    return;
  }
  addToCart(square);
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

function addToCart(square) {
  cart.push(square);
  checkoutSession = null;
  renderTerminal();
  dirty = true;
}

function removeFromCart(index) {
  cart.splice(index, 1);
  renderTerminal();
  dirty = true;
}

function clearCart() {
  cart = [];
  checkoutSession = null;
  window.clearInterval(holdTimer);
  renderTerminal();
  dirty = true;
}

// ---------------------------------------------------------------------------
// The buying terminal
// ---------------------------------------------------------------------------

const terminal = document.getElementById("terminal");
const terminalTitle = document.getElementById("terminal-title");
const terminalBody = document.getElementById("terminal-body");
const terminalFoot = document.getElementById("terminal-foot");

document.getElementById("terminal-close").addEventListener("click", () => {
  // In checkout the blocks are already reserved, so closing only hides the
  // panel. In cart mode nothing is held yet, so closing discards it.
  if (checkoutSession !== null) {
    checkoutSession = null;
    window.clearInterval(holdTimer);
    renderTerminal();
    return;
  }
  clearCart();
});

function renderTerminal() {
  if (checkoutSession !== null) {
    renderCheckout();
    return;
  }
  if (cart.length === 0) {
    terminal.hidden = true;
    return;
  }

  terminal.hidden = false;
  terminalTitle.textContent = "Your blocks (" + cart.length + ")";
  terminalBody.textContent = "";

  cart.forEach((item, index) => {
    const monthly = item.size * item.size * rateCentsPerMonth;
    terminalBody.append(
      lineRow({
        size: item.size,
        title: item.size + "x" + item.size + " block",
        sub: "(" + item.x + ", " + item.y + ") &middot; " + item.size * item.size + " tiles",
        price: money(monthly) + "/mo",
        onRemove: () => removeFromCart(index),
      }),
    );
  });

  const total = cart.reduce((sum, i) => sum + i.size * i.size * rateCentsPerMonth, 0);
  const tiles = cart.reduce((sum, i) => sum + i.size * i.size, 0);

  terminalFoot.textContent = "";
  terminalFoot.append(totalRow("Total", total));

  const button = document.createElement("button");
  button.type = "button";
  button.className = "buy";
  button.textContent = "Reserve and continue";
  button.addEventListener("click", () => {
    void startCheckout(button);
  });
  terminalFoot.append(button);

  const note = document.createElement("p");
  note.className = "note";
  note.innerHTML =
    tiles + " tile" + (tiles === 1 ? "" : "s") + " billed monthly. Reserving holds them " +
    "for 15 minutes while you pay." +
    (priceIsPlaceholder ? " <strong>Placeholder price.</strong>" : "");
  terminalFoot.append(note);
}

/**
 * Reserve the whole cart in one transaction, then show what the server priced.
 * From here on the total shown is the server's, not the one added up in the
 * page: the client never decides what anything costs.
 */
async function startCheckout(button) {
  button.disabled = true;
  button.textContent = "Reserving...";

  let response;
  try {
    response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placements: cart }),
    });
  } catch {
    toast("Could not reach the server.", "bad");
    button.disabled = false;
    button.textContent = "Reserve and continue";
    return;
  }

  const body = await response.json();

  if (response.status === 201) {
    checkoutSession = body;
    cart = [];
    await Promise.all([loadAvailability(), loadStats()]);
    renderCheckout();
    dirty = true;
    return;
  }

  // The optimistic bitmap said those squares were free; the server is the
  // authority and it disagreed. Nothing was reserved.
  if (response.status === 409) {
    for (const tile of body.conflicts ?? []) {
      flashes.push({ x: tile.x, y: tile.y, size: 1, kind: "bad", born: performance.now() });
    }
    toast(body.message ?? "Someone claimed one of those squares first.", "bad");
    await loadAvailability();
  } else {
    toast(body.message ?? "That checkout was rejected.", "bad");
  }

  button.disabled = false;
  button.textContent = "Reserve and continue";
  dirty = true;
}

function renderCheckout() {
  const session = checkoutSession;
  terminal.hidden = false;
  terminalTitle.textContent = "Checkout";
  terminalBody.textContent = "";

  for (const line of session.lines) {
    terminalBody.append(
      lineRow({
        size: line.size,
        title: line.size + "x" + line.size + " block",
        sub: "(" + line.x + ", " + line.y + ") &middot; " + line.tiles + " tiles",
        price: money(line.monthlyCents) + "/mo",
      }),
    );
  }

  terminalFoot.textContent = "";

  const hold = document.createElement("p");
  hold.className = "hold";
  terminalFoot.append(hold);
  terminalFoot.append(totalRow("Total", session.monthlyTotalCents));

  const pay = document.createElement("button");
  pay.type = "button";
  pay.className = "buy";
  pay.disabled = !session.ready;
  pay.textContent = session.ready ? "Pay with Paddle" : "Paddle not connected yet";
  terminalFoot.append(pay);

  const back = document.createElement("button");
  back.type = "button";
  back.className = "buy secondary";
  back.textContent = "Done";
  back.addEventListener("click", () => {
    checkoutSession = null;
    window.clearInterval(holdTimer);
    renderTerminal();
  });
  terminalFoot.append(back);

  const note = document.createElement("p");
  note.className = "note";
  note.innerHTML =
    "Checkout " + session.id.slice(0, 12) + "... &middot; " +
    money(session.rateCentsPerTilePerMonth) + " per tile per month." +
    (session.rateIsPlaceholder ? " <strong>Placeholder price.</strong>" : "") +
    " Tiles stay held until payment; if the hold lapses they go back on sale.";
  terminalFoot.append(note);

  window.clearInterval(holdTimer);
  const tick = () => {
    const left = new Date(session.expiresAt).getTime() - Date.now();
    if (left <= 0) {
      hold.innerHTML = "<b>Hold expired.</b> Those tiles are back on sale.";
      window.clearInterval(holdTimer);
      void loadAvailability();
      return;
    }
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    hold.innerHTML = "Tiles held for <b>" + m + ":" + String(sec).padStart(2, "0") + "</b>";
  };
  tick();
  holdTimer = window.setInterval(tick, 1000);
}

function lineRow(spec) {
  const row = document.createElement("div");
  row.className = "line";

  const swatch = document.createElement("div");
  swatch.className = "line-swatch";
  swatch.textContent = spec.size + "x" + spec.size;
  row.append(swatch);

  const main = document.createElement("div");
  main.className = "line-main";
  const title = document.createElement("div");
  title.className = "line-title";
  title.textContent = spec.title;
  const sub = document.createElement("div");
  sub.className = "line-sub";
  sub.innerHTML = spec.sub;
  main.append(title, sub);
  row.append(main);

  const price = document.createElement("div");
  price.className = "line-price";
  price.textContent = spec.price;
  row.append(price);

  if (spec.onRemove !== undefined) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "line-remove";
    remove.setAttribute("aria-label", "Remove");
    remove.innerHTML = "&times;";
    remove.addEventListener("click", spec.onRemove);
    row.append(remove);
  }
  return row;
}

function totalRow(label, cents) {
  const wrap = document.createElement("div");
  wrap.className = "total";
  const l = document.createElement("span");
  l.className = "total-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "total-value";
  v.innerHTML = money(cents) + "<small>/mo</small>";
  wrap.append(l, v);
  return wrap;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.querySelector(".dev").addEventListener("click", async (event) => {
  const action = event.target.dataset?.action;
  if (action === undefined) return;

  if (action === "sweep") {
    const result = await (await fetch("/api/sweep", { method: "POST" })).json();
    toast(
      `Swept ${result.expiredBlockIds.length} lapsed reservation(s), freed ${result.releasedTiles} tile(s).`,
      "ok",
    );
    await Promise.all([loadAvailability(), loadStats()]);
    return;
  }

  if (action === "reset") {
    await fetch("/api/reset", { method: "POST" });
    clearCart();
    toast("Board emptied. Restart the server to reseed.", "ok");
    await Promise.all([loadManifest(), loadAvailability(), loadStats(), loadComposite()]);
    await loadFeatured();
  }
});

window.addEventListener("resize", () => {
  resize();
  clampView();
  paintFeatured();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Stats first: it carries the tile size every coordinate calculation depends on.
await loadStats();
resize();
openingView();
requestAnimationFrame(frame);

void loadComposite();
void Promise.all([loadManifest(), loadAvailability(), loadFeatured()]);

// The watching count is server state that drifts once a minute, so poll for it
// rather than inventing a number per browser.
setInterval(() => {
  void loadStats();
}, 20_000);
