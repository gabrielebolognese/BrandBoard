// The featured column.
//
// Five slots down the left side, each one a block someone paid to feature. The
// important detail is that every slot runs its own clock: a window bought at
// noon ends at noon tomorrow, and one bought five hours later ends five hours
// after that. Nothing resets at midnight, so the countdowns are staggered and
// each is read straight from its own expiry.

import { createModal } from "./modal.js";

export function createFeaturedColumn({ listEl, buyEl, geometry, liveBlocks, onPurchase }) {
  let slots = [];
  let ticker = 0;

  const modal = createModal({ title: "Feature a block", width: 460 });
  let chosen = null;
  let days = 1;
  let pricing = new Map();

  buyEl.addEventListener("click", () => {
    chosen = null;
    days = 1;
    renderPurchase();
    modal.open();
  });

  // ---------------------------------------------------------------------------
  // The column
  // ---------------------------------------------------------------------------

  async function refresh() {
    const data = await (await fetch("/api/featured")).json();
    slots = data.blocks;
    render();
  }

  function render() {
    listEl.textContent = "";

    for (let i = 0; i < 5; i += 1) {
      const block = slots[i];
      const cell = document.createElement(block === undefined ? "div" : "button");
      cell.className = block === undefined ? "feat feat-empty" : "feat";

      if (block === undefined) {
        cell.innerHTML = '<span class="feat-vacant">Slot open</span>';
        listEl.append(cell);
        continue;
      }

      cell.type = "button";
      cell.title = `${block.name} @${block.handle}`;
      cell.addEventListener("click", () => {
        window.open(block.url, "_blank", "noopener,noreferrer");
      });

      const label = document.createElement("span");
      label.className = "feat-label";
      label.textContent = block.name;

      const left = document.createElement("span");
      left.className = "feat-clock";
      left.dataset.expires = block.expiresAt;

      cell.append(label, left);
      listEl.append(cell);
    }

    paintCrops();
    startTicking();
  }

  /** Each cell is a crop of the composite, so the column costs no extra requests. */
  function paintCrops() {
    const cells = listEl.querySelectorAll(".feat:not(.feat-empty)");
    const { tile, px } = geometry();
    cells.forEach((cell, i) => {
      const block = slots[i];
      if (block === undefined) return;
      const side = cell.clientWidth;
      if (side === 0) return;
      const k = side / (block.size * tile);
      cell.style.backgroundSize = `${px * k}px ${px * k}px`;
      cell.style.backgroundPosition = `${-block.x * tile * k}px ${-block.y * tile * k}px`;
    });
  }

  function startTicking() {
    window.clearInterval(ticker);
    const tick = () => {
      let expired = false;
      for (const node of listEl.querySelectorAll(".feat-clock")) {
        const left = new Date(node.dataset.expires).getTime() - Date.now();
        if (left <= 0) {
          expired = true;
          node.textContent = "expired";
          continue;
        }
        node.textContent = formatRemaining(left);
      }
      // A window closing changes who is featured, so go and ask.
      if (expired) void refresh();
    };
    tick();
    ticker = window.setInterval(tick, 1000);
  }

  function formatRemaining(ms) {
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (d > 0) return `${d}d ${h}h left`;
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m left`;
    return `${m}:${String(sec).padStart(2, "0")} left`;
  }

  // ---------------------------------------------------------------------------
  // Buying a window
  // ---------------------------------------------------------------------------

  function money(cents) {
    return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  /** $10 for the first day, $8 for each one after. The server prices it again. */
  function previewPrice(n) {
    return 1000 + (n - 1) * 800;
  }

  function renderPurchase() {
    modal.setTitle("Feature a block");
    modal.body.textContent = "";

    const pick = document.createElement("div");
    pick.className = "field";
    pick.innerHTML = '<label for="feat-pick">Block</label>';

    const select = document.createElement("select");
    select.id = "feat-pick";
    select.className = "select";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Choose a live block";
    select.append(blank);

    for (const block of liveBlocks()) {
      const option = document.createElement("option");
      option.value = block.id;
      option.textContent = `${block.name} (@${block.handle}) - ${block.size}x${block.size}`;
      select.append(option);
    }
    select.value = chosen ?? "";
    select.addEventListener("change", () => {
      chosen = select.value === "" ? null : select.value;
      renderFooter();
    });
    pick.append(select);
    modal.body.append(pick);

    const length = document.createElement("div");
    length.className = "field";
    length.innerHTML = '<label>Length</label>';

    const scale = document.createElement("div");
    scale.className = "days";
    for (let n = 1; n <= 10; n += 1) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "day";
      option.textContent = String(n);
      option.setAttribute("aria-pressed", String(n === days));
      option.addEventListener("click", () => {
        days = n;
        for (const other of scale.children) {
          other.setAttribute("aria-pressed", String(other === option));
        }
        renderBreakdown();
        renderFooter();
      });
      scale.append(option);
    }
    length.append(scale);
    modal.body.append(length);

    const breakdown = document.createElement("div");
    breakdown.className = "totals";
    breakdown.id = "feat-breakdown";
    modal.body.append(breakdown);

    renderBreakdown();
    renderFooter();
  }

  function renderBreakdown() {
    const wrap = modal.body.querySelector("#feat-breakdown");
    if (wrap === null) return;
    const cents = pricing.get(days) ?? previewPrice(days);

    wrap.textContent = "";
    wrap.append(row("First day", money(1000)));
    if (days > 1) wrap.append(row(`Additional days (${days - 1})`, money((days - 1) * 800)));
    wrap.append(row("Billing", "One off, does not renew"));

    const grand = document.createElement("div");
    grand.className = "totals-row totals-grand";
    grand.innerHTML = `<span>Total</span><span class="totals-amount">${money(cents)}</span>`;
    wrap.append(grand);
  }

  function row(label, value) {
    const el = document.createElement("div");
    el.className = "totals-row";
    el.innerHTML = `<span>${label}</span><span>${value}</span>`;
    return el;
  }

  function renderFooter() {
    modal.footer.textContent = "";

    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "btn btn-primary";
    buy.disabled = chosen === null;
    buy.textContent =
      chosen === null
        ? "Choose a block first"
        : `Feature for ${days} day${days === 1 ? "" : "s"}`;
    buy.addEventListener("click", () => void purchase(buy));
    modal.footer.append(buy);

    const caption = document.createElement("p");
    caption.className = "caption";
    caption.textContent =
      "The countdown starts the moment it is bought, not at midnight. Buying another " +
      "window later runs its own clock alongside this one.";
    modal.footer.append(caption);
  }

  async function purchase(trigger) {
    trigger.disabled = true;
    trigger.textContent = "Featuring...";

    let response;
    let body;
    try {
      response = await fetch("/api/featured", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blockId: chosen, days }),
      });
      body = await response.json();
    } catch {
      trigger.disabled = false;
      trigger.textContent = "Feature";
      return;
    }

    if (response.status !== 201) {
      modal.footer.prepend(resultBox("Could not feature", body.message ?? "Rejected."));
      trigger.disabled = false;
      renderFooter();
      return;
    }

    modal.footer.textContent = "";
    modal.footer.append(
      resultBox(
        "Featured",
        `Live until ${new Date(body.expiresAt).toLocaleString()}. ` +
          `${money(body.priceCents)} was not charged: Paddle is not connected yet.`,
      ),
    );
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn btn-ghost";
    done.textContent = "Close";
    done.addEventListener("click", () => modal.close());
    modal.footer.append(done);

    await refresh();
    onPurchase?.();
  }

  function resultBox(title, detail) {
    const el = document.createElement("div");
    el.className = "result";
    el.innerHTML = `<strong>${title}</strong><span>${detail}</span>`;
    return el;
  }

  return { refresh, repaint: paintCrops, loadPricing };

  async function loadPricing() {
    for (let n = 1; n <= 10; n += 1) {
      try {
        const quote = await (await fetch(`/api/featured/quote?days=${n}`)).json();
        pricing.set(n, quote.priceCents);
      } catch {
        // The preview formula stands in until the server answers.
      }
    }
  }
}
