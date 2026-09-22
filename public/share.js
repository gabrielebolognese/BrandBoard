// Sharing a planet.
//
// The two things an owner wants once they have bought a square: a link that
// unfurls into their planet, and something to put on their own site. Both are
// free distribution for the board, so they are one click away rather than
// buried in a dashboard nobody visits.

import { getJson } from "./http.js";
import { createModal } from "./modal.js";

export function createShare() {
  const modal = createModal({ title: "Share", width: 520 });
  let current = null;

  const preview = document.createElement("img");
  preview.className = "share-card";
  preview.alt = "";
  preview.loading = "lazy";

  const pageField = field("Your page", "The link to put in a bio.");
  const embedField = field("Embed", "Paste this where you want the badge.");

  modal.body.append(preview, pageField.wrap, embedField.wrap);

  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-ghost";
  done.textContent = "Done";
  done.addEventListener("click", () => modal.close());
  modal.footer.append(done);

  function field(label, hint) {
    const wrap = document.createElement("div");
    wrap.className = "share-field";

    const heading = document.createElement("p");
    heading.className = "share-label";
    heading.textContent = label;

    const note = document.createElement("p");
    note.className = "share-hint";
    note.textContent = hint;

    const row = document.createElement("div");
    row.className = "share-row";

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.className = "share-input";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "share-copy";
    copy.textContent = "Copy";

    copy.addEventListener("click", async () => {
      const copied = await writeToClipboard(input);
      // The button says what happened, because a copy with no feedback leaves
      // people clicking it again to be sure.
      copy.textContent = copied ? "Copied" : "Press Ctrl+C";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1400);
    });

    row.append(input, copy);
    wrap.append(heading, note, row);
    return { wrap, input };
  }

  async function writeToClipboard(input) {
    input.select();
    // The clipboard API is unavailable without a secure context, and refused
    // outright by some browsers, so the selection above is the fallback: it
    // leaves the text ready for the keyboard.
    if (navigator.clipboard === undefined) return false;
    try {
      await navigator.clipboard.writeText(input.value);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async open(block) {
      current = block.id;
      preview.removeAttribute("src");
      pageField.input.value = "";
      embedField.input.value = "";
      modal.setTitle(`Share @${block.handle}`);
      modal.open();

      const { ok, body } = await getJson(`/api/block/${block.id}/embed`);
      if (!ok || body === null || current !== block.id) return;

      preview.src = body.cardUrl;
      pageField.input.value = body.pageUrl;
      embedField.input.value = body.snippet;
    },
    close: () => modal.close(),
  };
}
