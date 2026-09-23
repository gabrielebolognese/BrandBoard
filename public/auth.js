// Signing in.
//
// Everything on the board belongs to somebody, so every action that spends
// money or changes a planet needs to know who is asking. This is the smallest
// thing that can answer that: an address, a link, and a cookie.

import { getJson, messageFrom, postJson } from "./http.js";
import { createModal } from "./modal.js";

export function createAuth({ slotEl, onChange }) {
  let user = null;
  let modal = null;

  function current() {
    return user;
  }

  async function refresh() {
    const { ok, body } = await getJson("/api/auth/me");
    user = ok && body !== null ? (body.user ?? null) : null;
    render();
    onChange?.(user);
    return user;
  }

  function render() {
    slotEl.textContent = "";

    if (user === null) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "auth-btn";
      button.textContent = "Sign in";
      button.addEventListener("click", () => open());
      slotEl.append(button);
      return;
    }

    const who = document.createElement("span");
    who.className = "auth-who";
    who.title = user.email ?? "";
    who.textContent = user.displayName ?? user.handle ?? shortEmail(user.email);

    const out = document.createElement("button");
    out.type = "button";
    out.className = "auth-btn ghost";
    out.textContent = "Sign out";
    out.addEventListener("click", () => void signOut());

    slotEl.append(who, out);
  }

  function shortEmail(email) {
    if (typeof email !== "string" || email === "") return "Signed in";
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email;
  }

  function build() {
    const dialog = createModal({ title: "Sign in", width: 420 });

    const blurb = document.createElement("p");
    blurb.className = "auth-blurb";
    blurb.textContent =
      "We send a link. No password to invent, and nothing to remember next time.";

    const label = document.createElement("label");
    label.className = "auth-label";
    label.setAttribute("for", "auth-email");
    label.textContent = "Email";

    const input = document.createElement("input");
    input.type = "email";
    input.id = "auth-email";
    input.className = "auth-input";
    input.placeholder = "you@example.com";
    input.autocomplete = "email";

    const note = document.createElement("p");
    note.className = "auth-note";
    note.hidden = true;

    dialog.body.append(blurb, label, input, note);

    const send = document.createElement("button");
    send.type = "button";
    send.className = "btn btn-primary";
    send.textContent = "Send the link";

    async function submit() {
      const email = input.value.trim();
      if (email === "") {
        note.hidden = false;
        note.className = "auth-note bad";
        note.textContent = "An address first.";
        input.focus();
        return;
      }

      send.disabled = true;
      send.textContent = "Sending...";
      const response = await postJson("/api/auth/request", { email });
      send.disabled = false;
      send.textContent = "Send the link";

      note.hidden = false;
      if (response.ok) {
        note.className = "auth-note good";
        // Deliberately not "we sent you a link": the server does not say
        // whether the address has an account, and neither does this.
        note.textContent =
          "If that address can receive mail, a link is on its way. It works once, for 15 minutes.";
        input.value = "";
        return;
      }

      note.className = "auth-note bad";
      note.textContent = messageFrom(response, "That did not work. Try again in a moment.");
    }

    send.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
    });

    dialog.footer.append(send);
    return { dialog, input, note, send };
  }

  function open(reason) {
    if (modal === null) modal = build();

    modal.note.hidden = true;
    modal.dialog.setTitle(reason ?? "Sign in");
    modal.dialog.open();
    modal.input.focus();
  }

  async function signOut() {
    await postJson("/api/auth/signout");
    user = null;
    render();
    onChange?.(null);
  }

  /**
   * The guard every paid action calls first.
   *
   * Returns the user, or opens the dialog and returns null. Callers stop when
   * it returns null rather than carrying on into a 401 they have to explain.
   */
  async function require(reason) {
    if (user !== null) return user;

    const fresh = await refresh();
    if (fresh !== null) return fresh;

    open(reason);
    return null;
  }

  /** Called on boot with whatever the sign-in redirect left in the URL. */
  function readRedirect(search) {
    const params = new URLSearchParams(search);
    if (params.get("signedin") === "1") return { kind: "signedin" };

    const failed = params.get("signin_error");
    if (failed !== null) {
      return {
        kind: "error",
        message:
          failed === "rate_limited"
            ? "Too many links asked for. Try again in an hour."
            : "That link has expired or was already used. Ask for another.",
      };
    }
    return null;
  }

  return { current, refresh, open, require, signOut, readRedirect };
}
