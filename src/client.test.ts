import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Boots the real client against a stubbed browser.
 *
 * This exists because of a bug that shipped: an edit anchored on a line that
 * lived in a different file, the replacement silently did nothing, and app.js
 * was left calling three functions it no longer defined. Every other check
 * passed. The server was healthy, the typechecker does not look at public/,
 * `node --check` only parses, and the page rendered absolutely nothing.
 *
 * Executing the module is the only thing that catches that, so this executes it
 * with just enough DOM to get through boot and a few frames. It is not a test
 * of how the universe looks; it is a test that the universe draws at all.
 */

const CANVAS_OPS: string[] = [];

function stubContext(): unknown {
  // The calls that have to return something usable. They are recorded too:
  // an earlier version returned them straight from the target, which meant the
  // gradients never appeared in CANVAS_OPS and a test could not tell a board
  // with auras from one without.
  const answering: Record<string, () => unknown> = {
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 10 }),
  };

  return new Proxy(
    { canvas: { width: 1200, height: 700 } } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop];

        const answer = answering[prop];
        if (answer !== undefined) {
          return (...args: unknown[]) => {
            CANVAS_OPS.push(prop);
            void args;
            return answer();
          };
        }

        return (...args: unknown[]) => {
          CANVAS_OPS.push(prop);
          void args;
        };
      },
      set: () => true,
    },
  );
}

function stubElement(): Record<string, unknown> {
  const element: Record<string, unknown> = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    hidden: false,
    textContent: "",
    innerHTML: "",
    // Inputs read their own value on boot, and an element without one throws
    // where the real page would simply have found an empty box.
    value: "",
    readOnly: false,
    clientWidth: 150,
    offsetParent: {},
    width: 1200,
    height: 700,
    getContext: () => stubContext(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700 }),
    addEventListener() {},
    append() {},
    prepend() {},
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    select() {},
    remove() {},
    hasPointerCapture: () => false,
    setPointerCapture() {},
    releasePointerCapture() {},
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
  };
  return element;
}

/** Exactly the shapes the server returns, so the client boots for real. */
function stubFetch(): void {
  const bitmap = Buffer.alloc(Math.ceil((300 * 300) / 8)).toString("base64");
  const bodies: Record<string, unknown> = {
    "/api/stats": {
      tilesTotal: 90_000,
      tilesAvailable: 89_000,
      blocksLive: 3,
      clicksDelivered: 0,
      watching: 300,
      tilePixels: 12,
      tileInset: 1,
      boardSize: 300,
      boardCenter: 150,
      universeRadius: 150,
      maxBlockSize: 25,
      orbits: [
        { name: "core", label: "Core", outerRadius: 20, centsPerTilePerMonth: 500 },
        { name: "inner", label: "Inner belt", outerRadius: 60, centsPerTilePerMonth: 300 },
        { name: "outer", label: "Outer reach", outerRadius: 150, centsPerTilePerMonth: 100 },
      ],
      billingPeriod: "month",
    },
    "/api/manifest": {
      version: "test",
      boardSize: 300,
      blocks: [
        { id: "a", x: 150, y: 150, size: 2, name: "A", handle: "a", url: "https://example.com" },
        { id: "b", x: 160, y: 140, size: 5, name: "B", handle: "b", url: "https://example.com" },
      ],
    },
    "/api/availability": { boardSize: 300, bits: bitmap, heldTiles: 0 },
    "/api/featured": { slots: 5, blocks: [] },
    "/api/orbits": {
      orbits: [
        { name: "core", label: "Core", capacity: 1264, taken: 12, remaining: 1252, fraction: 0.01 },
      ],
    },
    "/api/categories": { categories: [{ category: "music", count: 2 }] },
    "/api/auth/me": { user: null },
    "/api/directory": {
      total: 2,
      entries: [
        { id: "a", x: 150, y: 150, size: 2, name: "A", handle: "a", category: "music", clicks: 4 },
      ],
    },
  };

  vi.stubGlobal("fetch", (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
    const body = bodies[path] ?? {};
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  });
}

function stubBrowser(): void {
  stubFetch();
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    location: { search: "", pathname: "/" },
    history: { replaceState() {} },
    addEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    open() {},
    innerWidth: 1400,
    innerHeight: 900,
  });
  vi.stubGlobal("document", {
    body: stubElement(),
    createElement: () => stubElement(),
    getElementById: () => stubElement(),
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
  });
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 1);
      }
    },
  );
  vi.stubGlobal("atob", (b64: string) => Buffer.from(b64, "base64").toString("binary"));

  // A handful of frames is enough to prove the loop runs; then let it stop.
  let frames = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    if (frames++ > 3) return 0;
    setTimeout(fn, 0);
    return frames;
  });
}

describe("the client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("boots and draws without throwing", async () => {
    CANVAS_OPS.length = 0;
    stubBrowser();

    // Already a file:// URL; running it through pathToFileURL again mangles
    // the drive letter on Windows.
    const entry = new URL("../public/app.js", import.meta.url).href;
    await expect(import(/* @vite-ignore */ entry)).resolves.toBeDefined();

    // Give the loop a few frames to actually paint something.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Planets and rings are arcs; the sheet and halos are drawImage; the orbit
    // labels are fillText. If the module threw, none of these ever happened.
    expect(CANVAS_OPS).toContain("arc");
    expect(CANVAS_OPS).toContain("drawImage");
    expect(CANVAS_OPS).toContain("fillRect");

    // Named separately because "it drew something" is not the same claim as
    // "it drew the universe", and the thing people notice missing is the
    // universe: the orbit rings, their auras, and their labels. Twice now a
    // page has rendered a background and nothing else and every check passed.
    expect(CANVAS_OPS).toContain("stroke");
    expect(CANVAS_OPS).toContain("createRadialGradient");
    expect(CANVAS_OPS).toContain("fillText");
  }, 20_000);
});
