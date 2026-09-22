import { describe, expect, it } from "vitest";
import {
  PolarError,
  apiBase,
  cleanMetadata,
  createCheckout,
  interpretEvent,
  readPolarConfig,
} from "./polar.js";
import type { PolarConfig } from "./polar.js";

const config: PolarConfig = {
  accessToken: "polar_at_test",
  server: "sandbox",
  subscriptionProductId: "prod_sub",
  featuredProductId: "prod_feat",
  webhookSecret: "whsec_test",
};

/** Records what was sent and answers with whatever the test asked for. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

function sentBody(calls: Array<{ init: RequestInit }>): Record<string, unknown> {
  return JSON.parse(String(calls[0]?.init.body ?? "{}")) as Record<string, unknown>;
}

describe("configuration", () => {
  it("names every variable that is missing", () => {
    const result = readPolarConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([
      "POLAR_ACCESS_TOKEN",
      "POLAR_SUBSCRIPTION_PRODUCT_ID",
      "POLAR_FEATURED_PRODUCT_ID",
    ]);
  });

  it("treats an empty string as missing, because it is", () => {
    const result = readPolarConfig({
      POLAR_ACCESS_TOKEN: "   ",
      POLAR_SUBSCRIPTION_PRODUCT_ID: "prod_sub",
      POLAR_FEATURED_PRODUCT_ID: "prod_feat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(["POLAR_ACCESS_TOKEN"]);
  });

  // Getting this backwards either way is bad, but only one of the two charges a
  // real card by accident, so it is the value you get by saying nothing.
  it("defaults to sandbox", () => {
    const result = readPolarConfig({
      POLAR_ACCESS_TOKEN: "t",
      POLAR_SUBSCRIPTION_PRODUCT_ID: "s",
      POLAR_FEATURED_PRODUCT_ID: "f",
    });
    expect(result.ok && result.config.server).toBe("sandbox");
  });

  it("goes to production only when asked in so many words", () => {
    const base = {
      POLAR_ACCESS_TOKEN: "t",
      POLAR_SUBSCRIPTION_PRODUCT_ID: "s",
      POLAR_FEATURED_PRODUCT_ID: "f",
    };
    expect(readPolarConfig({ ...base, POLAR_SERVER: "PRODUCTION" }).ok).toBe(true);
    const shouting = readPolarConfig({ ...base, POLAR_SERVER: "PRODUCTION" });
    expect(shouting.ok && shouting.config.server).toBe("sandbox");

    const asked = readPolarConfig({ ...base, POLAR_SERVER: "production" });
    expect(asked.ok && asked.config.server).toBe("production");
  });

  it("points at different hosts for the two servers", () => {
    expect(apiBase("sandbox")).toBe("https://sandbox-api.polar.sh");
    expect(apiBase("production")).toBe("https://api.polar.sh");
  });
});

describe("opening a checkout", () => {
  it("sends the product, the amount and the metadata", async () => {
    const { impl, calls } = stubFetch(201, { id: "chk_1", url: "https://polar.sh/x", status: "open" });

    const session = await createCheckout(
      config,
      {
        productId: "prod_sub",
        amountCents: 6000,
        successUrl: "https://brandspace.app/?paid=1",
        metadata: { kind: "subscription", checkout_id: "chk_abc" },
      },
      { fetchImpl: impl },
    );

    expect(calls[0]?.url).toBe("https://sandbox-api.polar.sh/v1/checkouts/");
    expect(sentBody(calls)).toMatchObject({
      products: ["prod_sub"],
      amount: 6000,
      metadata: { kind: "subscription", checkout_id: "chk_abc" },
    });
    expect(session).toMatchObject({ id: "chk_1", url: "https://polar.sh/x" });
  });

  it("carries the token as a bearer", async () => {
    const { impl, calls } = stubFetch(201, { id: "c", url: "https://polar.sh/x" });

    await createCheckout(
      config,
      { productId: "p", amountCents: 500, successUrl: "https://x/", metadata: {} },
      { fetchImpl: impl },
    );

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer polar_at_test");
  });

  // The amount is the one thing that must never come from a browser, and a
  // fractional or negative one is a sign that it did.
  it.each([0, -100, 12.5, Number.NaN])("refuses to charge %p cents", async (amount) => {
    const { impl, calls } = stubFetch(201, { id: "c", url: "https://polar.sh/x" });

    await expect(
      createCheckout(
        config,
        { productId: "p", amountCents: amount, successUrl: "https://x/", metadata: {} },
        { fetchImpl: impl },
      ),
    ).rejects.toBeInstanceOf(PolarError);

    // And nothing was sent, which is the part that matters.
    expect(calls).toHaveLength(0);
  });

  it("reports what Polar objected to", async () => {
    const { impl } = stubFetch(422, { detail: [{ msg: "amount is below the minimum" }] });

    await expect(
      createCheckout(
        config,
        { productId: "p", amountCents: 1, successUrl: "https://x/", metadata: {} },
        { fetchImpl: impl },
      ),
    ).rejects.toThrow(/below the minimum/);
  });

  it("treats a success with no URL as a failure, because it is one", async () => {
    const { impl } = stubFetch(201, { id: "chk_1", status: "open" });

    await expect(
      createCheckout(
        config,
        { productId: "p", amountCents: 500, successUrl: "https://x/", metadata: {} },
        { fetchImpl: impl },
      ),
    ).rejects.toThrow(/returned no URL/);
  });

  it("turns an unreachable Polar into a 502 rather than a stack trace", async () => {
    const impl = (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;

    const failure = await createCheckout(
      config,
      { productId: "p", amountCents: 500, successUrl: "https://x/", metadata: {} },
      { fetchImpl: impl },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolarError);
    expect((failure as PolarError).status).toBe(502);
  });

  it("trims metadata to what Polar will accept", () => {
    const cleaned = cleanMetadata({ ["k".repeat(60)]: "v".repeat(600), days: 3 });

    expect(Object.keys(cleaned)[0]).toHaveLength(40);
    expect(Object.values(cleaned)[0]).toHaveLength(500);
    expect(cleaned["days"]).toBe("3");
  });
});

describe("reading an event", () => {
  it("fulfils a paid order against the checkout in its metadata", () => {
    const action = interpretEvent("order.paid", {
      id: "ord_1",
      subscription_id: "sub_1",
      metadata: { kind: "subscription", checkout_id: "chk_abc" },
      current_period_end: "2027-09-22T00:00:00Z",
    });

    expect(action).toMatchObject({
      kind: "fulfil",
      checkoutId: "chk_abc",
      subscriptionId: "sub_1",
    });
    expect(action.kind === "fulfil" && action.currentPeriodEnd?.getUTCFullYear()).toBe(2027);
  });

  // order.created fires when the order exists; order.paid fires when the money
  // settled. Only one of those is a reason to hand over a square.
  it("does nothing for an order that has only been created", () => {
    const action = interpretEvent("order.created", {
      metadata: { kind: "subscription", checkout_id: "chk_abc" },
    });
    expect(action.kind).toBe("ignore");
  });

  it("finds the metadata when it rides on the nested checkout instead", () => {
    const action = interpretEvent("order.paid", {
      checkout: { metadata: { kind: "subscription", checkout_id: "chk_nested" } },
      subscription: { id: "sub_2", current_period_end: "2027-01-01T00:00:00Z" },
    });

    expect(action).toMatchObject({ kind: "fulfil", checkoutId: "chk_nested", subscriptionId: "sub_2" });
  });

  it("ignores a paid order that carries no checkout at all", () => {
    expect(interpretEvent("order.paid", { id: "ord_1" }).kind).toBe("ignore");
  });

  it("reads a featured purchase as a featured purchase", () => {
    const action = interpretEvent("order.paid", {
      metadata: { kind: "featured", block_id: "blk_1", days: "4" },
    });
    expect(action).toEqual({ kind: "feature", blockId: "blk_1", days: 4 });
  });

  it("ignores a featured order with no day count", () => {
    const action = interpretEvent("order.paid", { metadata: { kind: "featured", block_id: "b" } });
    expect(action.kind).toBe("ignore");
  });

  it.each(["subscription.active", "subscription.cycled", "subscription.uncanceled"])(
    "treats %s as a renewal",
    (type) => {
      const action = interpretEvent(type, {
        id: "sub_9",
        current_period_end: "2028-03-01T00:00:00Z",
      });
      expect(action).toMatchObject({ kind: "renew", subscriptionId: "sub_9" });
    },
  );

  // The difference between these two is money. Cancelled means it will not
  // renew and they keep what they paid for; revoked means access is over now.
  // Releasing a square on cancellation takes back ground already paid for.
  it("does not release a square when a subscription is merely cancelled", () => {
    expect(interpretEvent("subscription.canceled", { id: "sub_9" }).kind).toBe("ignore");
  });

  it("releases a square when a subscription is revoked", () => {
    expect(interpretEvent("subscription.revoked", { id: "sub_9" })).toEqual({
      kind: "lapse",
      subscriptionId: "sub_9",
    });
  });

  it("survives a period end that is not a date", () => {
    const action = interpretEvent("subscription.active", {
      id: "sub_9",
      current_period_end: "whenever",
    });
    expect(action).toEqual({ kind: "renew", subscriptionId: "sub_9", currentPeriodEnd: null });
  });

  it("ignores anything it has no opinion about", () => {
    expect(interpretEvent("benefit_grant.created", {}).kind).toBe("ignore");
    expect(interpretEvent("order.paid", null).kind).toBe("ignore");
  });
});
