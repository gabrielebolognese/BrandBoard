// A dialog, and nothing to do with FlashBrand.
//
// Kept separate because a modal has its own obligations that have nothing to do
// with buying tiles: it traps focus, closes on Escape and on a backdrop click,
// restores focus to whatever opened it, and stops the page behind it from
// scrolling. Anything in the app that needs a dialog should use this rather
// than growing its own.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

let openCount = 0;

export function createModal({ title = "", width = 460, onClose } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.hidden = true;

  const dialog = document.createElement("div");
  dialog.className = "modal";
  dialog.style.maxWidth = `${width}px`;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const titleId = `modal-title-${Math.floor(performance.now() * 1000)}`;
  const header = document.createElement("header");
  header.className = "modal-head";

  const heading = document.createElement("h2");
  heading.className = "modal-title";
  heading.id = titleId;
  heading.textContent = title;
  dialog.setAttribute("aria-labelledby", titleId);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "modal-close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = "&times;";

  header.append(heading, close);

  const body = document.createElement("div");
  body.className = "modal-body";

  const footer = document.createElement("footer");
  footer.className = "modal-foot";

  dialog.append(header, body, footer);
  backdrop.append(dialog);
  document.body.append(backdrop);

  let lastFocused = null;

  function isOpen() {
    return !backdrop.hidden;
  }

  function open() {
    if (isOpen()) return;
    lastFocused = document.activeElement;
    backdrop.hidden = false;
    openCount += 1;
    document.body.classList.add("modal-open");
    // Focus the first useful control rather than the close button when there
    // is one, so a keyboard user lands on the action.
    const target = dialog.querySelector(".modal-foot " + FOCUSABLE) ?? close;
    target.focus();
  }

  function dismiss() {
    if (!isOpen()) return;
    backdrop.hidden = true;
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.classList.remove("modal-open");
    if (lastFocused instanceof HTMLElement) lastFocused.focus();
    onClose?.();
  }

  close.addEventListener("click", dismiss);

  backdrop.addEventListener("mousedown", (event) => {
    // Only a click on the backdrop itself, so a drag that ends outside the
    // dialog does not close it mid-gesture.
    if (event.target === backdrop) dismiss();
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...dialog.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return {
    body,
    footer,
    open,
    close: dismiss,
    isOpen,
    setTitle(text) {
      heading.textContent = text;
    },
  };
}
