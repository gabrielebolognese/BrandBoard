import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Guards on the static site, for faults that typechecking and the database
 * tests cannot see.
 *
 * These exist because a real one shipped: every dialog set `display` in a class
 * rule, which beats the user agent's `[hidden] { display: none }`, so both
 * modals were on screen from page load and the close button did nothing. The
 * server was healthy and every test passed.
 */

const PUBLIC = new URL("../public/", import.meta.url);

async function read(name: string): Promise<string> {
  return readFile(new URL(name, PUBLIC), "utf8");
}

describe("stylesheet", () => {
  it("makes [hidden] win against any class that sets display", async () => {
    const css = await read("styles.css");
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  /**
   * Not a style preference. Anything toggled through the hidden property needs
   * that guard, and this is the list of selectors that would silently defeat it
   * without one.
   */
  it("has the guard ahead of every rule that sets display", async () => {
    const css = await read("styles.css");
    const guard = css.search(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    const firstDisplay = css.search(/^\s*display:/m);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstDisplay);
  });
});

describe("markup and scripts", () => {
  it("references only scripts and stylesheets that exist", async () => {
    const html = await read("index.html");
    const files = new Set(await readdir(PUBLIC));

    // Only static assets: /board.webp is rendered by the server on request and
    // is deliberately not a file on disk.
    const referenced = [...html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(files.has(file as string), `index.html references missing /${file}`).toBe(true);
    }
  });

  /**
   * A getElementById for markup that no longer exists throws at module load and
   * takes the whole page with it, which is exactly what happens when a chunk of
   * HTML is replaced and one reference is missed.
   */
  it("looks up only ids that exist in the markup or are created in script", async () => {
    const html = await read("index.html");
    const scripts = await Promise.all(
      ["app.js", "checkout.js", "featured.js", "modal.js", "http.js"].map(read),
    );
    const js = scripts.join("\n");

    const inMarkup = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const madeInScript = new Set([...js.matchAll(/\.id = ["'`]([^"'`$]+)["'`]/g)].map((m) => m[1]));

    const lookups = [...js.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect(lookups.length).toBeGreaterThan(0);

    for (const id of lookups) {
      const known = inMarkup.has(id as string) || madeInScript.has(id as string);
      expect(known, `getElementById("${id}") matches nothing in index.html`).toBe(true);
    }
  });

  it("leaves no reference to markup that was removed", async () => {
    const js = (
      await Promise.all(["app.js", "checkout.js", "featured.js"].map(read))
    ).join("\n");
    // The docked panel this replaced.
    expect(js).not.toMatch(/terminal-(body|foot|head|close|title)/);
  });
});

describe("client requests", () => {
  /**
   * `await res.json()` throws on a non-JSON body, which is what a crashed
   * process or a proxy error page returns. Every call goes through http.js so
   * that failure is a value rather than an unhandled rejection.
   */
  it("parses responses only through the shared helper", async () => {
    for (const name of ["app.js", "checkout.js", "featured.js"]) {
      const source = await read(name);
      expect(source, `${name} calls .json() directly`).not.toMatch(/\.json\(\)/);
    }
  });
});
