// The directory panel: search, categories, and how much ground is left.
//
// A few hundred planets can be browsed by eye. A full universe cannot, and a
// board whose only way in is recognising someone's avatar stops being a
// directory and becomes wallpaper. This is the way in.

import { getJson } from "./http.js";

const DEBOUNCE_MS = 180;

export function createDirectory({ panelEl, toggleEl, onFocus, onShare }) {
  const searchEl = panelEl.querySelector("[data-role=search]");
  const chipsEl = panelEl.querySelector("[data-role=chips]");
  const scarcityEl = panelEl.querySelector("[data-role=scarcity]");
  const resultsEl = panelEl.querySelector("[data-role=results]");
  const countEl = panelEl.querySelector("[data-role=count]");
  const closeEl = panelEl.querySelector("[data-role=close]");

  let category = null;
  let timer = 0;
  // Every search is a race against the one before it. Without a sequence the
  // slower request can land last and overwrite the newer results.
  let sequence = 0;

  function isOpen() {
    return !panelEl.hidden;
  }

  function open() {
    if (isOpen()) return;
    panelEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", "true");
    searchEl.focus();
    void refresh();
  }

  function close() {
    panelEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  async function loadScarcity() {
    const { ok, body } = await getJson("/api/orbits");
    if (!ok || body === null) return;

    scarcityEl.textContent = "";
    for (const orbit of Array.isArray(body.orbits) ? body.orbits : []) {
      const row = document.createElement("div");
      row.className = "scarcity-row";

      const label = document.createElement("span");
      label.className = "scarcity-label";
      label.textContent = orbit.label;

      const bar = document.createElement("span");
      bar.className = "scarcity-bar";
      const fill = document.createElement("span");
      fill.className = `scarcity-fill orbit-${orbit.name}`;
      // A board that is one percent sold should still show something, or the
      // bar reads as broken rather than as empty.
      fill.style.width = `${Math.max(1.5, Number(orbit.fraction ?? 0) * 100).toFixed(1)}%`;
      bar.append(fill);

      const left = document.createElement("span");
      left.className = "scarcity-left";
      left.textContent = `${Number(orbit.remaining ?? 0).toLocaleString()} left`;

      row.append(label, bar, left);
      scarcityEl.append(row);
    }
  }

  async function loadCategories() {
    const { ok, body } = await getJson("/api/categories");
    if (!ok || body === null) return;

    chipsEl.textContent = "";
    chipsEl.append(chip("All", null));
    for (const entry of Array.isArray(body.categories) ? body.categories : []) {
      chipsEl.append(chip(`${entry.category} ${entry.count}`, entry.category));
    }
  }

  function chip(label, value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = label;
    if (value === category) button.classList.add("on");
    button.addEventListener("click", () => {
      category = category === value ? null : value;
      for (const other of chipsEl.querySelectorAll(".chip")) other.classList.remove("on");
      if (category !== null || value === null) button.classList.add("on");
      void refresh();
    });
    return button;
  }

  async function refresh() {
    const mine = (sequence += 1);
    const params = new URLSearchParams({ limit: "60" });
    const text = searchEl.value.trim();
    if (text !== "") params.set("q", text);
    if (category !== null) params.set("category", category);

    const { ok, body } = await getJson(`/api/directory?${params.toString()}`);
    if (mine !== sequence) return;

    if (!ok || body === null) {
      resultsEl.textContent = "";
      countEl.textContent = "could not load";
      return;
    }

    // Everything here is read defensively. http.js exists because one caller
    // that trusted a response took the whole page down with it, and a panel
    // that empties itself is a far better failure than a board that stops.
    const total = Number(body.total ?? 0);
    countEl.textContent = total === 0 ? "nothing here" : `${total.toLocaleString()} planets`;
    render(Array.isArray(body.entries) ? body.entries : []);
  }

  function render(entries) {
    resultsEl.textContent = "";

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dir-empty";
      empty.textContent = "No planets match that.";
      resultsEl.append(empty);
      return;
    }

    for (const entry of entries) {
      // A row, not a button: it carries a button of its own, and a button
      // inside a button is markup no browser agrees about.
      const row = document.createElement("div");
      row.className = "dir-row";

      const go = document.createElement("button");
      go.type = "button";
      go.className = "dir-go";
      go.title = `Find ${entry.name} on the board`;

      // An img rather than a background, purely so loading="lazy" applies.
      // Sixty rows meant sixty planet renders the moment the panel opened,
      // each one a database read and a sharp composite, all competing with the
      // request that fills the panel in the first place. The browser now asks
      // for the handful that are actually on screen.
      const avatar = document.createElement("img");
      avatar.className = "dir-avatar";
      avatar.loading = "lazy";
      avatar.decoding = "async";
      avatar.width = 34;
      avatar.height = 34;
      avatar.alt = "";
      avatar.src = `/api/planet/${entry.id}?px=64`;

      const text = document.createElement("span");
      text.className = "dir-text";

      const name = document.createElement("span");
      name.className = "dir-name";
      name.textContent = entry.name;

      const meta = document.createElement("span");
      meta.className = "dir-meta";
      const bits = [`@${entry.handle}`, `${entry.size}x${entry.size}`];
      if (entry.category) bits.push(entry.category);
      const clicks = Number(entry.clicks ?? 0);
      if (clicks > 0) bits.push(`${clicks.toLocaleString()} clicks`);
      meta.textContent = bits.join(" · ");

      text.append(name, meta);
      go.append(avatar, text);

      const share = document.createElement("button");
      share.type = "button";
      share.className = "dir-share";
      share.title = `Share @${entry.handle}`;
      share.setAttribute("aria-label", `Share @${entry.handle}`);
      share.textContent = "↗";

      row.append(go, share);

      go.addEventListener("click", () => {
        onFocus?.(entry);
        // Left open on purpose: people search, look, come back, search again.
      });
      share.addEventListener("click", () => onShare?.(entry));

      resultsEl.append(row);
    }
  }

  searchEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), DEBOUNCE_MS);
  });

  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  closeEl.addEventListener("click", close);
  toggleEl.addEventListener("click", toggle);

  return {
    open,
    close,
    toggle,
    isOpen,
    /** Called after a purchase or a change, so counts and bars stay honest. */
    async reload() {
      await Promise.all([loadScarcity(), loadCategories()]);
      if (isOpen()) await refresh();
    },
  };
}
