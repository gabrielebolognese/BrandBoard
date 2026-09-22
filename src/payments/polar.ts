/**
 * Polar.
 *
 * Polar is the merchant of record, which is the whole reason it was chosen: on
 * subscriptions of five to fifty dollars a year, registering for sales tax in
 * every jurisdiction that wants it would cost more than the revenue. Their fee
 * buys that liability off.
 *
 * Two products cover everything, both with custom prices. The price of a planet
 * is the sum of its tiles, which is continuous rather than a tier list, so a
 * catalog of fixed prices cannot express it: the amount is computed here and
 * sent with the checkout. That also means the amount is never accepted from the
 * browser, which is the only rule in this file that really matters.
 */

export type PolarServer = "sandbox" | "production";

export interface PolarConfig {
  readonly accessToken: string;
  readonly server: PolarServer;
  /** A recurring yearly product with a custom price. Planets are billed on it. */
  readonly subscriptionProductId: string;
  /** A one-time product with a custom price. Featured windows are billed on it. */
  readonly featuredProductId: string;
  readonly webhookSecret: string | null;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: PolarConfig }
  | { readonly ok: false; readonly missing: string[] };

const REQUIRED = [
  "POLAR_ACCESS_TOKEN",
  "POLAR_SUBSCRIPTION_PRODUCT_ID",
  "POLAR_FEATURED_PRODUCT_ID",
] as const;

/**
 * Reads the configuration, and says exactly what is missing when it is not
 * there.
 *
 * "Payments are not configured" is a message someone reads at eleven at night
 * while wondering which of six environment variables they forgot, so it names
 * them.
 */
export function readPolarConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const missing = REQUIRED.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });

  if (missing.length > 0) return { ok: false, missing: [...missing] };

  const server = env["POLAR_SERVER"] === "production" ? "production" : "sandbox";
  const secret = env["POLAR_WEBHOOK_SECRET"];

  return {
    ok: true,
    config: {
      accessToken: (env["POLAR_ACCESS_TOKEN"] ?? "").trim(),
      server,
      subscriptionProductId: (env["POLAR_SUBSCRIPTION_PRODUCT_ID"] ?? "").trim(),
      featuredProductId: (env["POLAR_FEATURED_PRODUCT_ID"] ?? "").trim(),
      webhookSecret: secret === undefined || secret === "" ? null : secret,
    },
  };
}

/**
 * Sandbox is the default.
 *
 * Getting this backwards in either direction is bad, but only one of the two
 * charges a real card by accident, so the safe value is the one you get by
 * saying nothing.
 */
export function apiBase(server: PolarServer): string {
  return server === "production" ? "https://api.polar.sh" : "https://sandbox-api.polar.sh";
}

export class PolarError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PolarError";
    this.status = status;
  }
}

export interface CheckoutInput {
  readonly productId: string;
  /** Whole cents, computed on the server. Never taken from a request body. */
  readonly amountCents: number;
  readonly successUrl: string;
  readonly metadata: Record<string, string | number>;
  readonly customerEmail?: string;
}

export interface CheckoutSession {
  readonly id: string;
  /** Where to send the buyer. */
  readonly url: string;
  readonly status: string;
  readonly totalAmountCents: number | null;
}

export interface RequestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Polar's limits: 50 pairs, keys to 40 characters, values to 500. */
export function cleanMetadata(input: Record<string, string | number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input).slice(0, 50)) {
    if (value === undefined || value === null) continue;
    out[key.slice(0, 40)] = String(value).slice(0, 500);
  }
  return out;
}

/**
 * Opens a checkout and returns where to send the buyer.
 *
 * The amount travels with the request because both products are custom-priced.
 * A rounded or fractional amount would be rejected by Polar with a validation
 * error that says nothing useful, so it is refused here with one that does.
 */
export async function createCheckout(
  config: PolarConfig,
  input: CheckoutInput,
  options: RequestOptions = {},
): Promise<CheckoutSession> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new PolarError(`Refusing to charge ${input.amountCents} cents.`, 400);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const body = {
    products: [input.productId],
    amount: input.amountCents,
    success_url: input.successUrl,
    metadata: cleanMetadata(input.metadata),
    ...(input.customerEmail !== undefined ? { customer_email: input.customerEmail } : {}),
  };

  let response: Response;
  try {
    response = await doFetch(`${apiBase(config.server)}/v1/checkouts/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new PolarError(`Could not reach Polar: ${reason(error)}`, 502);
  }

  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new PolarError(`Polar refused the checkout: ${detailOf(parsed, text)}`, response.status);
  }

  const session = (parsed ?? {}) as Record<string, unknown>;
  const id = session["id"];
  const url = session["url"];
  if (typeof id !== "string" || typeof url !== "string") {
    throw new PolarError("Polar accepted the checkout but returned no URL.", 502);
  }

  return {
    id,
    url,
    status: typeof session["status"] === "string" ? session["status"] : "unknown",
    totalAmountCents:
      typeof session["total_amount"] === "number" ? session["total_amount"] : null,
  };
}

/** Polar puts validation problems in `detail`, which is a string or a list. */
function detailOf(parsed: unknown, fallback: string): string {
  if (typeof parsed === "object" && parsed !== null) {
    const detail = (parsed as Record<string, unknown>)["detail"];
    if (typeof detail === "string") return detail.slice(0, 300);
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) =>
          typeof item === "object" && item !== null
            ? String((item as Record<string, unknown>)["msg"] ?? "")
            : "",
        )
        .filter((message) => message !== "");
      if (messages.length > 0) return messages.join("; ").slice(0, 300);
    }
    const error = (parsed as Record<string, unknown>)["error"];
    if (typeof error === "string") return error.slice(0, 300);
  }
  return fallback.slice(0, 300) || "no detail given";
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timed out";
    return error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type PolarAction =
  /** The money arrived for a cart. Deliver what the blocks can still be given. */
  | {
      readonly kind: "fulfil";
      readonly checkoutId: string;
      readonly subscriptionId: string | null;
      readonly currentPeriodEnd: Date | null;
    }
  /** A one-time purchase of a featured window. */
  | { readonly kind: "feature"; readonly blockId: string; readonly days: number }
  /** A renewal went through: the paid-through date moved. */
  | {
      readonly kind: "renew";
      readonly subscriptionId: string;
      readonly currentPeriodEnd: Date | null;
    }
  /** Access has ended. Release the tiles. */
  | { readonly kind: "lapse"; readonly subscriptionId: string }
  | { readonly kind: "ignore"; readonly reason: string };

/**
 * Turns one delivery into one decision.
 *
 * Kept apart from the route that receives it, because this is the part with
 * judgement in it and judgement is what wants testing. The route does signature
 * checking, idempotency and HTTP; this decides what a thing means.
 *
 * Polar distinguishes cancelled from revoked, and the difference is money:
 * cancelled means it will not renew, and the customer keeps what they paid for
 * until the period ends. Only revoked means access is over now. Releasing a
 * square on cancellation would take back ground someone had already paid for.
 */
export function interpretEvent(eventType: string, data: unknown): PolarAction {
  const payload = (data ?? {}) as Record<string, unknown>;

  switch (eventType) {
    // order.paid rather than order.created: created fires when the order exists,
    // paid fires when the money actually settled, and only one of those is a
    // reason to hand over a square.
    case "order.paid": {
      const meta = metadataOf(payload);
      const kind = meta["kind"];

      if (kind === "featured") {
        const blockId = meta["block_id"];
        const days = Number(meta["days"]);
        if (typeof blockId !== "string" || !Number.isInteger(days)) {
          return { kind: "ignore", reason: "featured order without a block and a day count" };
        }
        return { kind: "feature", blockId, days };
      }

      const checkoutId = meta["checkout_id"];
      if (typeof checkoutId !== "string" || checkoutId === "") {
        return { kind: "ignore", reason: "order carried no checkout_id in its metadata" };
      }

      return {
        kind: "fulfil",
        checkoutId,
        subscriptionId: stringOr(payload["subscription_id"], subscriptionIdOf(payload)),
        currentPeriodEnd: periodEndOf(payload),
      };
    }

    // The first one arrives with the order; the later ones are renewals.
    case "subscription.active":
    case "subscription.cycled":
    case "subscription.uncanceled": {
      const id = payload["id"];
      if (typeof id !== "string") return { kind: "ignore", reason: "subscription without an id" };
      return { kind: "renew", subscriptionId: id, currentPeriodEnd: periodEndOf(payload) };
    }

    case "subscription.revoked": {
      const id = payload["id"];
      if (typeof id !== "string") return { kind: "ignore", reason: "subscription without an id" };
      return { kind: "lapse", subscriptionId: id };
    }

    // Deliberately not a lapse. They have paid through the end of the period and
    // the sweep takes the square back when that date passes.
    case "subscription.canceled":
      return { kind: "ignore", reason: "cancelled, and paid through the end of the period" };

    default:
      return { kind: "ignore", reason: `nothing to do for ${eventType}` };
  }
}

/**
 * Where the metadata is.
 *
 * Polar copies checkout metadata onto the objects that follow it, but which
 * object carries it depends on the event, so all three places are looked at
 * rather than one being assumed. Everything here is a string, because that is
 * all Polar stores.
 */
function metadataOf(payload: Record<string, unknown>): Record<string, string> {
  const sources = [
    payload["metadata"],
    nested(payload, "checkout"),
    nested(payload, "subscription"),
  ];

  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (typeof source !== "object" || source === null) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (merged[key] === undefined && (typeof value === "string" || typeof value === "number")) {
        merged[key] = String(value);
      }
    }
  }
  return merged;
}

function nested(payload: Record<string, unknown>, key: string): unknown {
  const child = payload[key];
  if (typeof child !== "object" || child === null) return null;
  return (child as Record<string, unknown>)["metadata"] ?? null;
}

function subscriptionIdOf(payload: Record<string, unknown>): string | null {
  const child = payload["subscription"];
  if (typeof child !== "object" || child === null) return null;
  const id = (child as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : null;
}

function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * The date the current period runs to.
 *
 * An unparseable date becomes null rather than an Invalid Date, which would
 * reach Postgres and fail the insert at the least convenient moment.
 */
function periodEndOf(payload: Record<string, unknown>): Date | null {
  const candidates = [payload["current_period_end"], nestedValue(payload, "subscription", "current_period_end")];

  for (const candidate of candidates) {
    if (typeof candidate !== "string" && typeof candidate !== "number") continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function nestedValue(
  payload: Record<string, unknown>,
  key: string,
  field: string,
): unknown {
  const child = payload[key];
  if (typeof child !== "object" || child === null) return null;
  return (child as Record<string, unknown>)[field] ?? null;
}
