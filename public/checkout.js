// Cart and checkout.
//
// Owns everything between choosing a square and handing off to the payment
// provider: what is in the cart, what the server priced it at, and the three
// states the dialog can be in. The board knows none of this; it calls add()
// and asks which squares are spoken for.
//
// Two round trips, each meaning something:
//   review  -> nothing is held, prices are indicative
//   reserve -> tiles are held atomically and the server returns the real price
//   pay     -> hand off to the provider
//
// The prices rendered after reserving are the server's. The figures shown
// before that are a preview, and are labelled as one.

import { messageFrom, postJson } from "./http.js";
import { createModal } from "./modal.js";

export function createCheckout({ priceOf, onChange, onReserved, onConflict }) {
  let items = [];
  let session = null;
  let step = "review";
  let payState = { status: "idle" };
  let holdTimer = 0;

  const modal = createModal({
    title: "Your order",
    width: 470,
    onClose: () => {
      window.clearInterval(holdTimer);
      holdTimer = 0;
    },
  });

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "cart-launcher";
  launcher.hidden = true;
  launcher.addEventListener("click", () => openAt("review"));
  document.body.append(launcher);

  // -------------------------------------------------------------------------
  // Cart
  // -------------------------------------------------------------------------

  function add(square) {
    items = [...items, square];
    session = null;
    step = "review";
    renderLauncher();
    onChange?.();
  }

  function remove(index) {
    items = items.filter((_, i) => i !== index);
    if (items.length === 0) modal.close();
    renderLauncher();
    render();
    onChange?.();
  }

  function clear() {
    items = [];
    session = null;
    step = "review";
    payState = { status: "idle" };
    renderLauncher();
    modal.close();
    onChange?.();
  }

  /** Squares the board should draw as pending: cart, or a live reservation. */
  function pending() {
    if (session !== null) {
      return session.lines.map((line) => ({ x: line.x, y: line.y, size: line.size }));
    }
    return items;
  }

  function claims(square) {
    return pending().some(
      (item) =>
        square.x < item.x + item.size &&
        item.x < square.x + square.size &&
        square.y < item.y + item.size &&
        item.y < square.y + square.size,
    );
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function money(cents) {
    return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function renderLauncher() {
    if (items.length === 0 && session === null) {
      launcher.hidden = true;
      return;
    }
    launcher.hidden = false;

    if (session !== null) {
      launcher.innerHTML =
        `<span class="cart-count">${session.lines.length}</span>` +
        `<span>Reserved</span>` +
        `<span class="cart-total">${money(session.monthlyTotalCents)}/mo</span>`;
      return;
    }

    const total = items.reduce((sum, i) => sum + priceOf(i), 0);
    launcher.innerHTML =
      `<span class="cart-count">${items.length}</span>` +
      `<span>${items.length === 1 ? "block" : "blocks"} selected</span>` +
      `<span class="cart-total">${money(total)}/mo</span>`;
  }

  function openAt(next) {
    step = next;
    render();
    modal.open();
  }

  function render() {
    if (step === "review") return renderReview();
    return renderPayment();
  }

  function summaryRows(lines, { removable = false } = {}) {
    const list = document.createElement("ul");
    list.className = "summary";

    lines.forEach((line, index) => {
      const row = document.createElement("li");
      row.className = "summary-row";

      const swatch = document.createElement("span");
      swatch.className = "summary-swatch";
      swatch.textContent = `${line.size}×${line.size}`;

      const label = document.createElement("span");
      label.className = "summary-label";
      label.innerHTML =
        `<span class="summary-name">${line.size}×${line.size} block</span>` +
        `<span class="summary-meta">Position ${line.x}, ${line.y} &middot; ${line.tiles} tiles</span>`;

      const price = document.createElement("span");
      price.className = "summary-price";
      price.textContent = `${money(line.monthlyCents)}/mo`;

      row.append(swatch, label, price);

      if (removable) {
        const drop = document.createElement("button");
        drop.type = "button";
        drop.className = "summary-remove";
        drop.setAttribute("aria-label", `Remove the ${line.size} by ${line.size} planet`);
        drop.innerHTML = "&times;";
        drop.addEventListener("click", () => remove(index));
        row.append(drop);
      }
      list.append(row);
    });

    return list;
  }

  function totals(lines, monthlyTotal, { indicative }) {
    const tiles = lines.reduce((sum, line) => sum + line.tiles, 0);
    const wrap = document.createElement("div");
    wrap.className = "totals";

    wrap.append(
      totalLine("Planets", String(lines.length)),
      totalLine("Tiles", tiles.toLocaleString()),
      totalLine("Billing", "Monthly, recurring"),
    );

    const grand = document.createElement("div");
    grand.className = "totals-row totals-grand";
    grand.innerHTML =
      `<span>${indicative ? "Estimated total" : "Total"}</span>` +
      `<span class="totals-amount">${money(monthlyTotal)}<small>/mo</small></span>`;
    wrap.append(grand);
    return wrap;
  }

  function totalLine(label, value) {
    const row = document.createElement("div");
    row.className = "totals-row";
    row.innerHTML = `<span>${label}</span><span>${value}</span>`;
    return row;
  }

  function renderReview() {
    modal.setTitle("Your order");
    const lines = items.map((item) => ({
      ...item,
      tiles: item.size * item.size,
      monthlyCents: priceOf(item),
    }));
    const total = lines.reduce((sum, line) => sum + line.monthlyCents, 0);

    modal.body.textContent = "";
    modal.body.append(summaryRows(lines, { removable: true }));
    modal.body.append(totals(lines, total, { indicative: true }));

    modal.footer.textContent = "";

    const reserve = button("primary", "Reserve orbit and continue");
    reserve.addEventListener("click", () => void doReserve(reserve));
    modal.footer.append(reserve);

    modal.footer.append(
      caption(
        "Reserving holds these tiles for 15 minutes while you pay. " +
          "Nothing is charged at this step.",
      ),
    );
  }

  function renderPayment() {
    modal.setTitle("Checkout");
    modal.body.textContent = "";
    modal.body.append(summaryRows(session.lines));
    modal.body.append(totals(session.lines, session.monthlyTotalCents, { indicative: false }));

    const hold = document.createElement("p");
    hold.className = "hold";
    modal.body.append(hold);
    startCountdown(hold);

    modal.footer.textContent = "";

    if (payState.status === "unavailable") {
      modal.footer.append(
        result(
          "Payment is not connected",
          `This order is valid and your tiles are held, but ${session.provider} has not been ` +
            "wired up yet, so nothing was charged.",
        ),
      );
    } else if (payState.status === "error") {
      modal.footer.append(result("Could not start payment", payState.message));
    }

    const pay = button("primary", `Pay ${money(session.monthlyTotalCents)} per month`);
    if (payState.status === "working") {
      pay.disabled = true;
      pay.textContent = "Contacting payment provider...";
    }
    pay.addEventListener("click", () => void doPay(pay));
    modal.footer.append(pay);

    const cancel = button("ghost", "Keep browsing");
    cancel.addEventListener("click", () => modal.close());
    modal.footer.append(cancel);

    modal.footer.append(
      caption(
        `Order ${session.id.slice(0, 16)}. ` +
          `${money(session.rateCentsPerTilePerMonth)} per tile per month` +
          `${session.rateIsPlaceholder ? ", placeholder pricing" : ""}.`,
      ),
    );
  }

  function startCountdown(node) {
    window.clearInterval(holdTimer);
    const tick = () => {
      const left = new Date(session.expiresAt).getTime() - Date.now();
      if (left <= 0) {
        node.className = "hold hold-expired";
        node.textContent = "The hold on these tiles has expired and they are back on sale.";
        window.clearInterval(holdTimer);
        void onReserved?.();
        return;
      }
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      node.className = "hold";
      node.innerHTML = `Tiles held for <b>${m}:${String(s).padStart(2, "0")}</b>`;
    };
    tick();
    holdTimer = window.setInterval(tick, 1000);
  }

  // -------------------------------------------------------------------------
  // Server
  // -------------------------------------------------------------------------

  async function doReserve(trigger) {
    trigger.disabled = true;
    trigger.textContent = "Reserving...";

    const response = await postJson("/api/checkout", { placements: items });
    const body = response.body;

    if (response.status === 201 && body !== null) {
      session = body;
      items = [];
      payState = { status: "idle" };
      step = "payment";
      renderLauncher();
      await onReserved?.();
      render();
      onChange?.();
      return;
    }

    // The board's availability map is a hint; the server decides. Nothing was
    // reserved, so the cart is left exactly as it was.
    trigger.disabled = false;
    trigger.textContent = "Reserve orbit and continue";
    if (response.status === 409 && body !== null) {
      onConflict?.(body);
      modal.close();
      return;
    }
    modal.footer.prepend(
      result("Could not reserve", messageFrom(response, "That order was rejected.")),
    );
  }

  async function doPay(trigger) {
    payState = { status: "working" };
    trigger.disabled = true;
    trigger.textContent = "Contacting payment provider...";

    const response = await postJson(`/api/checkout/${session.id}/pay`);
    const body = response.body;

    if (response.status === 0 || response.error !== null) {
      payState = { status: "error", message: messageFrom(response, "Could not reach the server.") };
      render();
      return;
    }

    // What a wired-up provider will return: somewhere to send the buyer.
    if (response.status === 200 && body?.redirectUrl !== undefined) {
      window.location.href = body.redirectUrl;
      return;
    }

    // 503 is the honest answer while the provider is unconfigured: the order is
    // real, the tiles are held, and no charge was attempted.
    payState =
      response.status === 503
        ? { status: "unavailable" }
        : { status: "error", message: messageFrom(response, "Payment could not be started.") };

    if (response.status === 410) {
      // The hold lapsed. The order is gone, so drop it rather than showing a
      // pay button for tiles somebody else can now buy.
      session = null;
      step = "review";
      payState = { status: "idle" };
      renderLauncher();
      await onReserved?.();
      modal.close();
      onConflict?.({
        message: messageFrom(response, "The hold expired and the tiles were released."),
      });
      return;
    }
    render();
  }

  // -------------------------------------------------------------------------
  // Small builders
  // -------------------------------------------------------------------------

  function button(kind, label) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `btn btn-${kind}`;
    el.textContent = label;
    return el;
  }

  function caption(text) {
    const el = document.createElement("p");
    el.className = "caption";
    el.textContent = text;
    return el;
  }

  function notice(text) {
    const el = document.createElement("p");
    el.className = "notice";
    el.textContent = text;
    return el;
  }

  function result(title, detail) {
    const el = document.createElement("div");
    el.className = "result";
    const head = document.createElement("strong");
    head.textContent = title;
    const body = document.createElement("span");
    body.textContent = detail;
    el.append(head, body);
    return el;
  }

  return { add, remove, clear, claims, pending, open: () => openAt(step), items: () => items };
}
