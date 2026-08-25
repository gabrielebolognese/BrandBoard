// Choosing a planet, dressing it, and paying for it.
//
// The order of those matters. Price is not shown while someone is picking a
// spot, or in the cart, or while they are filling in who they are: deciding
// where you want to be and deciding whether it is worth it are different
// questions, and a number on screen during the first one makes it the only
// question. The figure appears once, at the end, beside what it buys.
//
// Four steps, each meaning something:
//   cart     -> nothing held, nothing priced
//   reserve  -> tiles held atomically, and the clock starts
//   details  -> the photo, the aura, the link, the description
//   payment  -> the price, the reach, and the two ways to go live
//
// Reserving before the form is deliberate. Filling in a listing takes minutes,
// and nobody should lose the square they chose while typing.

import { messageFrom, postBinary, postJson } from "./http.js";
import { createModal } from "./modal.js";

export function createCheckout({ settings, onChange, onReserved, onConflict }) {
  let items = [];
  let session = null;
  let step = "details";
  let holdTimer = 0;

  const listing = { name: "", url: "", description: "", aura: "azure", photo: null };
  let uploaded = false;
  let payState = { status: "idle" };

  const modal = createModal({
    title: "Your planet",
    width: 460,
    onClose: () => {
      window.clearInterval(holdTimer);
      holdTimer = 0;
    },
  });

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "cart-launcher";
  launcher.hidden = true;
  launcher.addEventListener("click", () => void proceed());
  document.body.append(launcher);

  // -------------------------------------------------------------------------
  // The cart
  // -------------------------------------------------------------------------

  function add(square) {
    items = [...items, square];
    session = null;
    renderLauncher();
    onChange?.();
  }

  function remove(index) {
    items = items.filter((_, i) => i !== index);
    renderLauncher();
    onChange?.();
  }

  function clear() {
    items = [];
    session = null;
    step = "details";
    uploaded = false;
    payState = { status: "idle" };
    renderLauncher();
    modal.close();
    onChange?.();
  }

  /** Squares the board draws as pending: chosen, or held by a live order. */
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

  function money(cents) {
    return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  /** No price here on purpose: what is chosen, and the way forward. */
  function renderLauncher() {
    if (items.length === 0 && session === null) {
      launcher.hidden = true;
      return;
    }
    launcher.hidden = false;

    const count = session !== null ? session.lines.length : items.length;
    launcher.innerHTML =
      `<span class="cart-count">${count}</span>` +
      `<span>${count === 1 ? "planet" : "planets"} ${session !== null ? "held" : "chosen"}</span>` +
      `<span class="cart-go">${session !== null ? "Continue" : "Proceed"}</span>`;
  }

  // -------------------------------------------------------------------------
  // Reserving
  // -------------------------------------------------------------------------

  async function proceed() {
    if (session !== null) {
      render();
      modal.open();
      return;
    }
    if (items.length === 0) return;

    launcher.disabled = true;
    const response = await postJson("/api/checkout", { placements: items });
    launcher.disabled = false;

    if (response.status === 201 && response.body !== null) {
      session = response.body;
      items = [];
      step = "details";
      renderLauncher();
      await onReserved?.();
      onChange?.();
      render();
      modal.open();
      return;
    }

    // The board's map of what is free is a hint; the server decides. Nothing
    // was held, so the choice is left exactly as it was.
    if (response.status === 409 && response.body !== null) {
      onConflict?.(response.body);
      return;
    }
    onConflict?.({ message: messageFrom(response, "Those spots could not be held.") });
  }

  function render() {
    if (session === null) return;
    if (step === "payment") return renderPayment();
    return renderDetails();
  }

  // -------------------------------------------------------------------------
  // Step one: what the planet looks like
  // -------------------------------------------------------------------------

  function renderDetails() {
    modal.setTitle("Your planet");
    modal.body.textContent = "";

    const preview = document.createElement("div");
    preview.className = "planet-preview";
    const orb = document.createElement("div");
    orb.className = "planet-orb";
    orb.id = "planet-orb";
    const hint = document.createElement("p");
    hint.className = "preview-hint";
    hint.id = "preview-hint";
    hint.textContent = "Add a photo to see your planet";
    preview.append(orb, hint);
    modal.body.append(preview);

    const photoField = document.createElement("div");
    photoField.className = "field";
    const photoLabel = document.createElement("label");
    photoLabel.textContent = "Photo";
    photoField.append(photoLabel);

    const picker = document.createElement("label");
    picker.className = "filepick";
    picker.textContent = uploaded ? "Change image" : "Choose an image";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      if (chosen !== undefined) void takePhoto(chosen);
    });
    picker.append(file);
    photoField.append(picker);
    modal.body.append(photoField);

    const auraField = document.createElement("div");
    auraField.className = "field";
    const auraLabel = document.createElement("label");
    auraLabel.textContent = "Aura";
    auraField.append(auraLabel);

    const swatches = document.createElement("div");
    swatches.className = "auras";
    for (const aura of settings().auras ?? []) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "aura";
      swatch.title = aura.label;
      swatch.setAttribute("aria-label", aura.label);
      swatch.setAttribute("aria-pressed", String(aura.name === listing.aura));
      swatch.style.setProperty("--aura", `rgb(${aura.rgb})`);
      swatch.addEventListener("click", () => {
        listing.aura = aura.name;
        for (const other of swatches.children) {
          other.setAttribute("aria-pressed", String(other === swatch));
        }
        paintPreview();
      });
      swatches.append(swatch);
    }
    auraField.append(swatches);
    modal.body.append(auraField);

    modal.body.append(
      textField("Name", "text", listing.name, 60, "How you are known", (value) => {
        listing.name = value;
        refreshNext();
      }),
    );
    modal.body.append(
      textField("Link", "url", listing.url, 300, "yoursite.com", (value) => {
        listing.url = value;
        refreshNext();
      }),
    );
    modal.body.append(
      textField("Description", "textarea", listing.description, 280, "One line about you", (v) => {
        listing.description = v;
      }),
    );

    modal.footer.textContent = "";

    const hold = document.createElement("p");
    hold.className = "hold";
    modal.footer.append(hold);
    startCountdown(hold);

    const next = button("primary", "Next");
    next.id = "details-next";
    next.addEventListener("click", () => void saveAndContinue(next));
    modal.footer.append(next);

    modal.footer.append(
      caption("Nothing is charged yet. Your spot is held while you fill this in."),
    );

    paintPreview();
    refreshNext();
  }

  function textField(label, kind, value, maxLength, placeholder, onInput) {
    const field = document.createElement("div");
    field.className = "field";
    const tag = document.createElement("label");
    tag.textContent = label;
    field.append(tag);

    const input = document.createElement(kind === "textarea" ? "textarea" : "input");
    if (kind !== "textarea") input.type = kind;
    if (kind === "textarea") input.rows = 2;
    input.className = "input";
    input.value = value;
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    field.append(input);
    return field;
  }

  function refreshNext() {
    const next = document.getElementById("details-next");
    if (next === null) return;
    const ready = uploaded && listing.name.trim() !== "" && listing.url.trim() !== "";
    next.disabled = !ready;
    next.textContent = ready ? "Next" : "Add a photo, a name and a link";
  }

  /** The planet as it will look: the photo, inside its chosen aura. */
  function paintPreview() {
    const orb = document.getElementById("planet-orb");
    if (orb === null) return;
    const aura = (settings().auras ?? []).find((a) => a.name === listing.aura);
    const rgb = aura?.rgb ?? "96, 165, 250";
    orb.style.boxShadow = `0 0 44px 10px rgba(${rgb}, 0.45), 0 0 96px 34px rgba(${rgb}, 0.18)`;
    if (listing.photo !== null) {
      orb.style.backgroundImage = `url(${listing.photo})`;
      orb.classList.add("has-photo");
    }
  }

  async function takePhoto(chosen) {
    // Show it straight away from the local file; the upload confirms it.
    listing.photo = URL.createObjectURL(chosen);
    paintPreview();
    say("Uploading...");

    const response = await postBinary(`/api/upload/${session.id}`, chosen, chosen.type);

    if (response.status !== 201) {
      uploaded = false;
      listing.photo = null;
      document.getElementById("planet-orb")?.classList.remove("has-photo");
      say(messageFrom(response, "That image was not accepted."));
      refreshNext();
      return;
    }

    uploaded = true;
    say("This is how it will look");
    refreshNext();
  }

  function say(text) {
    const hint = document.getElementById("preview-hint");
    if (hint !== null) hint.textContent = text;
  }

  async function saveAndContinue(trigger) {
    trigger.disabled = true;
    trigger.textContent = "Saving...";

    const response = await postJson(`/api/listing/${session.id}`, {
      displayName: listing.name,
      primaryUrl: listing.url,
      description: listing.description,
      aura: listing.aura,
    });

    if (response.status !== 200) {
      trigger.disabled = false;
      refreshNext();
      modal.footer.prepend(
        result("Could not save", messageFrom(response, "Check the details and try again.")),
      );
      return;
    }

    step = "payment";
    render();
  }

  // -------------------------------------------------------------------------
  // Step two: what it costs, and what it is worth
  // -------------------------------------------------------------------------

  function renderPayment() {
    modal.setTitle("Go live");
    modal.body.textContent = "";

    const list = document.createElement("ul");
    list.className = "summary";
    for (const line of session.lines) {
      const row = document.createElement("li");
      row.className = "summary-row";

      const swatch = document.createElement("span");
      swatch.className = "summary-swatch";
      swatch.textContent = `${line.size}×${line.size}`;

      const label = document.createElement("span");
      label.className = "summary-label";
      const name = document.createElement("span");
      name.className = "summary-name";
      name.textContent = `${line.size}×${line.size} planet`;
      const meta = document.createElement("span");
      meta.className = "summary-meta";
      meta.textContent = `${line.orbit} · ${line.tiles} tiles`;
      label.append(name, meta);

      const price = document.createElement("span");
      price.className = "summary-price";
      price.textContent = `${money(line.monthlyCents)}/mo`;

      row.append(swatch, label, price);
      list.append(row);
    }
    modal.body.append(list);

    if (session.reach !== undefined) {
      const reach = document.createElement("div");
      reach.className = "reach";
      const figure = document.createElement("strong");
      figure.textContent =
        `${session.reach.low.toLocaleString()} to ${session.reach.high.toLocaleString()}` +
        " clicks a month";
      const basis = document.createElement("span");
      // Said plainly: a projection, not a promise.
      basis.textContent = `Projected from ${session.reach.basis}. Not a guarantee.`;
      reach.append(figure, basis);
      modal.body.append(reach);
    }

    const totals = document.createElement("div");
    totals.className = "totals";
    const grand = document.createElement("div");
    grand.className = "totals-row totals-grand";
    grand.innerHTML =
      `<span>Total</span><span class="totals-amount">${money(session.monthlyTotalCents)}` +
      `<small>/mo</small></span>`;
    totals.append(grand);
    modal.body.append(totals);

    modal.footer.textContent = "";

    if (payState.status !== "trialling") {
      const hold = document.createElement("p");
      hold.className = "hold";
      modal.footer.append(hold);
      startCountdown(hold);
    }

    if (payState.status === "unavailable") {
      modal.footer.append(
        result(
          "Payment is not connected",
          "Your order is valid and your tiles are held, but the payment provider is not " +
            "wired up yet, so nothing was charged. The free trial works in the meantime.",
        ),
      );
    } else if (payState.status === "error") {
      modal.footer.append(result("Could not start payment", payState.message));
    } else if (payState.status === "trialling") {
      modal.footer.append(
        result("You are live", `Your planet is in review. The trial runs until ${payState.until}.`),
      );
    }

    if (payState.status !== "trialling") {
      // The total is already on screen directly above. Restating it on the
      // button turns a step into a sales pitch.
      const pay = button("primary", "Checkout");
      if (payState.status === "working") {
        pay.disabled = true;
        pay.textContent = "Contacting payment provider...";
      }
      pay.addEventListener("click", () => void doPay(pay));
      modal.footer.append(pay);

      const trial = button("ghost", `Start a ${session.trialDays ?? 3} day free trial instead`);
      trial.addEventListener("click", () => void doTrial(trial));
      modal.footer.append(trial);
    }

    const back = button("ghost", payState.status === "trialling" ? "Done" : "Back");
    back.addEventListener("click", () => {
      if (payState.status === "trialling") {
        clear();
        return;
      }
      step = "details";
      render();
    });
    modal.footer.append(back);

    modal.footer.append(
      caption(
        `Order ${session.id.slice(0, 16)}. Billed monthly, cancel any time. ` +
          "Your planet goes into review before it appears.",
      ),
    );
  }

  async function doPay(trigger) {
    payState = { status: "working" };
    trigger.disabled = true;

    const response = await postJson(`/api/checkout/${session.id}/pay`);
    const body = response.body;

    if (response.status === 200 && body?.redirectUrl !== undefined) {
      window.location.href = body.redirectUrl;
      return;
    }
    if (response.status === 410) {
      onConflict?.({ message: messageFrom(response, "The hold expired.") });
      clear();
      await onReserved?.();
      return;
    }

    payState =
      response.status === 503
        ? { status: "unavailable" }
        : { status: "error", message: messageFrom(response, "Payment could not be started.") };
    render();
  }

  async function doTrial(trigger) {
    trigger.disabled = true;
    trigger.textContent = "Starting...";

    const response = await postJson(`/api/checkout/${session.id}/trial`);
    if (response.status !== 201 || response.body === null) {
      trigger.disabled = false;
      render();
      modal.footer.prepend(
        result("Could not start the trial", messageFrom(response, "That was refused.")),
      );
      return;
    }

    payState = {
      status: "trialling",
      until: new Date(response.body.trialEndsAt).toLocaleString(),
    };
    window.clearInterval(holdTimer);
    await onReserved?.();
    render();
  }

  function startCountdown(node) {
    window.clearInterval(holdTimer);
    const tick = () => {
      const left = new Date(session.expiresAt).getTime() - Date.now();
      if (left <= 0) {
        node.className = "hold hold-expired";
        node.textContent = "The hold on these tiles has expired.";
        window.clearInterval(holdTimer);
        void onReserved?.();
        return;
      }
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      node.className = "hold";
      node.innerHTML = `Held for <b>${m}:${String(s).padStart(2, "0")}</b>`;
    };
    tick();
    holdTimer = window.setInterval(tick, 1000);
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

  return { add, remove, clear, claims, pending, open: proceed, items: () => items };
}
