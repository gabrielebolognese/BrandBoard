import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimBlock } from "../board/claim.js";
import { runReservationSweep } from "../board/cleanup.js";
import { approveBlock, lapseSubscription, rejectBlock, releaseLapsedSubscriptions } from "../board/lifecycle.js";
import { createCheckout } from "../board/checkout.js";
import { countTiles, createTestUser, hasDatabase, resetBoard, setupTestDatabase } from "../test/db.js";
import { recordWebhookEvent, unprocessedEvents, markEventProcessed } from "./events.js";
import { fulfilPayment, outstandingRefunds, settleRefund } from "./fulfilment.js";
import { MONTHLY_FLOOR_CENTS, orderTotals } from "../config.js";
import { signPayload, verifyWebhookSignature } from "./signature.js";

import { monthlyPriceCents } from "../config.js";

/** What the orbits say a planet at this spot costs; the tests assert against it. */
const priceOf = (x: number, y: number, size: number) => monthlyPriceCents(x, y, size);

describe("webhook signatures", () => {
  const secret = "whsec_dGVzdHNlY3JldGtleWZvcnNpZ25pbmc=";
  const body = '{"type":"order.paid","data":{"id":"ord_1"}}';

  /** Verifies with the headers a provider would actually send. */
  function check(overrides = {}) {
    const signed = signPayload(body, secret);
    return verifyWebhookSignature({ rawBody: body, secret, ...signed, ...overrides });
  }

  it("accepts a signature the provider would have produced", () => {
    expect(check().valid).toBe(true);
  });

  it("refuses a body that was altered after signing", () => {
    const signed = signPayload(body, secret);
    const result = verifyWebhookSignature({
      rawBody: body.replace("ord_1", "ord_2"),
      secret,
      ...signed,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  /**
   * The delivery id is inside the signed content, so a captured delivery
   * cannot be replayed claiming to be a different one.
   */
  it("refuses a signature reused under another delivery id", () => {
    expect(check({ id: "msg_someone_elses" }).valid).toBe(false);
  });

  it("refuses the wrong secret", () => {
    const signed = signPayload(body, secret);
    expect(
      verifyWebhookSignature({ rawBody: body, secret: "whsec_d3Jvbmc=", ...signed }).valid,
    ).toBe(false);
  });

  it("refuses a stale signature", () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const signed = signPayload(body, secret, "msg_old", twoHoursAgo);
    const result = verifyWebhookSignature({ rawBody: body, secret, ...signed });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/out of date/);
  });

  it("accepts one good signature among several, as during a key rotation", () => {
    const signed = signPayload(body, secret);
    const mixed = `v1,not-the-one ${signed.signature}`;
    expect(
      verifyWebhookSignature({ rawBody: body, secret, ...signed, signature: mixed }).valid,
    ).toBe(true);
  });

  it("refuses when anything is missing, rather than defaulting to allow", () => {
    expect(check({ secret: undefined }).valid).toBe(false);
    expect(check({ id: undefined }).valid).toBe(false);
    expect(check({ timestamp: undefined }).valid).toBe(false);
    expect(check({ signature: undefined }).valid).toBe(false);
    expect(check({ signature: "garbage" }).valid).toBe(false);
    expect(check({ signature: "v1," }).valid).toBe(false);
  });
});

describe("what an order costs", () => {
  it("charges a year at a time", () => {
    const totals = orderTotals([2000]);
    expect(totals.months).toBe(12);
    expect(totals.interval).toBe("year");
    expect(totals.termTotalCents).toBe(2000 * 12);
  });

  /**
   * The reason the floor exists: card processing on a dollar costs a third of
   * it, so the smallest planets are charged the floor rather than refused.
   */
  it("lifts an order under the floor up to it, and says so", () => {
    const totals = orderTotals([100]);
    expect(totals.monthlySubtotalCents).toBe(100);
    expect(totals.monthlyTotalCents).toBe(MONTHLY_FLOOR_CENTS);
    expect(totals.termTotalCents).toBe(MONTHLY_FLOOR_CENTS * 12);
    expect(totals.floorApplied).toBe(true);
  });

  it("leaves an order above the floor alone", () => {
    const totals = orderTotals([300, 400]);
    expect(totals.monthlyTotalCents).toBe(700);
    expect(totals.floorApplied).toBe(false);
  });

  it("applies the floor to the order, not to each planet", () => {
    // Three one dollar planets are three dollars, which is still under the
    // floor; they are not three separate five dollar charges.
    const totals = orderTotals([100, 100, 100]);
    expect(totals.monthlyTotalCents).toBe(MONTHLY_FLOOR_CENTS);
  });
});

/** Stands in for the listing setup step, which review happens after. */
async function fillListing(pool: Pool, blockId: string, handle: string): Promise<void> {
  await pool.query(
    `UPDATE blocks
        SET image_url = 'https://cdn.example/a.webp',
            display_name = $2,
            handle = $2,
            primary_url = 'https://example.com'
      WHERE id = $1`,
    [blockId, handle],
  );
}

const suite = describe.skipIf(!hasDatabase);

suite("payments [requires DATABASE_URL]", () => {
  let pool: Pool;
  let buyer: string;
  let rival: string;

  beforeAll(async () => {
    pool = await setupTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetBoard(pool);
    buyer = await createTestUser(pool, "buyer");
    rival = await createTestUser(pool, "rival");
  });

  describe("webhook idempotency", () => {
    it("records a delivery once, however many times it arrives", async () => {
      const event = { provider: "paddle", eventId: "evt_1", eventType: "transaction.completed", payload: { a: 1 } };

      const first = await recordWebhookEvent(pool, event);
      const second = await recordWebhookEvent(pool, event);
      const third = await recordWebhookEvent(pool, event);

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(third.duplicate).toBe(true);
      // The same row throughout, so a handler keyed on it cannot run twice.
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
    });

    it("keeps events from different providers apart", async () => {
      const a = await recordWebhookEvent(pool, { provider: "paddle", eventId: "evt_1", eventType: "x", payload: {} });
      const b = await recordWebhookEvent(pool, { provider: "stripe", eventId: "evt_1", eventType: "x", payload: {} });
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(false);
    });

    it("surfaces deliveries that were never finished", async () => {
      const one = await recordWebhookEvent(pool, { provider: "paddle", eventId: "e1", eventType: "x", payload: {} });
      await recordWebhookEvent(pool, { provider: "paddle", eventId: "e2", eventType: "x", payload: {} });
      await markEventProcessed(pool, one.id, "done");

      const stuck = await unprocessedEvents(pool);
      expect(stuck).toHaveLength(1);
      expect(stuck[0]?.eventType).toBe("x");
    });
  });

  describe("fulfilment", () => {
    async function order(x: number, y: number, size: number) {
      return createCheckout(pool, buyer, [{ x, y, size }]);
    }

    it("delivers a paid order into review, not straight onto the board", async () => {
      const session = await order(110, 110, 3);
      const result = await fulfilPayment(pool, {
        checkoutId: session.id,
        subscriptionId: "sub_1",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      });

      expect(result.status).toBe("fulfilled");
      expect(result.delivered).toHaveLength(1);
      expect(result.refundCents).toBe(0);

      const block = await pool.query<{ status: string; reserved_until: Date | null; subscription_id: string }>(
        `SELECT status, reserved_until, subscription_id FROM blocks WHERE checkout_session_id = $1`,
        [session.id],
      );
      // Invariant 4: paying buys a place in the queue, not a place on the board.
      expect(block.rows[0]?.status).toBe("pending_review");
      expect(block.rows[0]?.reserved_until).toBeNull();
      expect(block.rows[0]?.subscription_id).toBe("sub_1");
      // Tiles stay held throughout review.
      expect(await countTiles(pool)).toBe(9);
    });

    it("is safe to run twice, in case an event is replayed past the event table", async () => {
      const session = await order(110, 110, 2);
      const first = await fulfilPayment(pool, { checkoutId: session.id });
      const second = await fulfilPayment(pool, { checkoutId: session.id });

      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("fulfilled");
      expect(second.delivered).toHaveLength(1);
      expect(second.refundCents).toBe(0);
      expect(await outstandingRefunds(pool)).toHaveLength(0);
    });

    /**
     * The case this whole module exists for: the hold lapsed, someone else took
     * the square, and only then did the money arrive.
     */
    it("refunds instead of delivering when the tiles were lost mid-payment", async () => {
      const session = await createCheckout(pool, buyer, [{ x: 120, y: 120, size: 2 }], {
        reservationMinutes: -1, // already lapsed
      });

      // The sweep frees it and a rival takes the square.
      await runReservationSweep(pool);
      await claimBlock(pool, rival, { x: 120, y: 120, size: 2 });

      const result = await fulfilPayment(pool, { checkoutId: session.id });

      expect(result.status).toBe("nothing_delivered");
      expect(result.delivered).toHaveLength(0);
      expect(result.lost).toHaveLength(1);
      expect(result.refundCents).toBe(priceOf(110, 110, 2));

      const owed = await outstandingRefunds(pool);
      expect(owed).toHaveLength(1);
      expect(owed[0]?.reason).toBe("tiles_lost");
      expect(owed[0]?.amountCents).toBe(priceOf(120, 120, 2));

      // The rival keeps the square: losing a race never takes it back.
      const winner = await pool.query<{ user_id: string }>(
        `SELECT b.user_id FROM occupied_tiles t JOIN blocks b ON b.id = t.block_id
          WHERE t.x = 120 AND t.y = 120`,
      );
      expect(winner.rows[0]?.user_id).toBe(rival);
    });

    it("delivers what survived and refunds only the rest", async () => {
      const session = await createCheckout(
        pool,
        buyer,
        [
          { x: 130, y: 130, size: 2 },
          { x: 140, y: 140, size: 1 },
        ],
              );

      // One square is quietly lost while the payment is in flight.
      await pool.query(`DELETE FROM occupied_tiles WHERE x = 140 AND y = 140`);
      await pool.query(`UPDATE blocks SET status = 'expired' WHERE x = 140 AND y = 140`);

      const result = await fulfilPayment(pool, { checkoutId: session.id });

      expect(result.status).toBe("partially_fulfilled");
      expect(result.delivered).toHaveLength(1);
      expect(result.lost).toHaveLength(1);
      expect(result.refundCents).toBe(priceOf(140, 140, 1));
    });

    it("does not owe the same refund twice when fulfilment repeats", async () => {
      const session = await createCheckout(pool, buyer, [{ x: 150, y: 150, size: 1 }], {
        reservationMinutes: -1,
      });
      await runReservationSweep(pool);

      await fulfilPayment(pool, { checkoutId: session.id });
      await fulfilPayment(pool, { checkoutId: session.id });

      expect(await outstandingRefunds(pool)).toHaveLength(1);
    });

    it("reports an order it has never heard of", async () => {
      const result = await fulfilPayment(pool, {
        checkoutId: "chk_00000000-0000-0000-0000-000000000000",
      });
      expect(result.status).toBe("unknown_checkout");
    });
  });

  describe("refund settlement", () => {
    it("stays outstanding until a provider confirms it, and only settles once", async () => {
      const session = await createCheckout(pool, buyer, [{ x: 160, y: 160, size: 1 }], {
        reservationMinutes: -1,
      });
      await runReservationSweep(pool);
      await fulfilPayment(pool, { checkoutId: session.id });

      const [owed] = await outstandingRefunds(pool);
      if (owed === undefined) throw new Error("expected a refund to be owed");

      expect(await settleRefund(pool, owed.id, "adj_123")).toEqual({ settled: true });
      expect(await outstandingRefunds(pool)).toHaveLength(0);
      // A second attempt changes nothing, so a retrying adapter cannot refund twice.
      expect(await settleRefund(pool, owed.id, "adj_456")).toEqual({ settled: false });
    });
  });

  describe("review", () => {
    async function paidBlock(x: number, y: number, size: number): Promise<string> {
      const session = await createCheckout(pool, buyer, [{ x, y, size }]);
      const result = await fulfilPayment(pool, { checkoutId: session.id });
      const block = result.delivered[0];
      if (block === undefined) throw new Error("expected a delivered block");
      await fillListing(pool, block.id, `creator${x}x${y}`);
      return block.id;
    }

    it("publishes an approved block and keeps its tiles", async () => {
      const id = await paidBlock(110, 110, 2);
      expect(await approveBlock(pool, id)).toEqual({ published: true });


      const row = await pool.query<{ status: string; published_at: Date }>(
        `SELECT status, published_at FROM blocks WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]?.status).toBe("live");
      expect(row.rows[0]?.published_at).not.toBeNull();
      expect(await countTiles(pool)).toBe(4);
    });

    it("releases the tiles and books a refund when a block is rejected", async () => {
      const id = await paidBlock(110, 110, 2);
      const result = await rejectBlock(pool, id);

      expect(result).toEqual({
        rejected: true,
        tilesReleased: 4,
        refundCents: priceOf(110, 110, 2),
      });
      expect(await countTiles(pool)).toBe(0);

      const owed = await outstandingRefunds(pool);
      expect(owed[0]?.reason).toBe("rejected_in_review");

      // And the square is immediately buyable again.
      const replacement = await claimBlock(pool, rival, { x: 110, y: 110, size: 2 });
      expect(replacement.id).toBeDefined();
    });

    it("refuses to publish a listing with nothing to render", async () => {
      // Paid for, but the listing setup step never happened.
      const session = await createCheckout(pool, buyer, [{ x: 180, y: 180, size: 1 }]);
      const result = await fulfilPayment(pool, { checkoutId: session.id });
      const block = result.delivered[0];
      if (block === undefined) throw new Error("expected a delivered block");

      expect(await approveBlock(pool, block.id)).toEqual({
        published: false,
        reason: "incomplete_listing",
      });
    });

    it("will not reject something that was never in review", async () => {
      const reserved = await claimBlock(pool, buyer, { x: 170, y: 170, size: 1 });
      const result = await rejectBlock(pool, reserved.id);
      expect(result.rejected).toBe(false);
      expect(await outstandingRefunds(pool)).toHaveLength(0);
    });
  });

  describe("subscriptions that stop paying", () => {
    async function liveBlock(x: number, y: number, size: number, subscriptionId: string, periodEnd: Date) {
      const session = await createCheckout(pool, buyer, [{ x, y, size }]);
      const result = await fulfilPayment(pool, {
        checkoutId: session.id,
        subscriptionId,
        currentPeriodEnd: periodEnd,
      });
      const block = result.delivered[0];
      if (block === undefined) throw new Error("expected a delivered block");
      await fillListing(pool, block.id, `sub${x}x${y}`);
      const approved = await approveBlock(pool, block.id);
      expect(approved.published).toBe(true);
      return block.id;
    }

    it("frees every block a cancelled subscription was paying for", async () => {
      const future = new Date(Date.now() + 30 * 86_400_000);
      await liveBlock(110, 110, 2, "sub_a", future);
      await liveBlock(120, 120, 3, "sub_a", future);
      await liveBlock(130, 130, 1, "sub_b", future);

      const result = await lapseSubscription(pool, "sub_a");

      expect(result.blocks).toHaveLength(2);
      expect(result.tilesReleased).toBe(13);
      // sub_b is untouched.
      expect(await countTiles(pool)).toBe(1);
      expect(result.refundCents).toBe(0);
    });

    it("refunds on lapse only when the policy asks for it", async () => {
      const future = new Date(Date.now() + 30 * 86_400_000);
      await liveBlock(110, 110, 2, "sub_c", future);

      const result = await lapseSubscription(pool, "sub_c", { refundRemainder: true });
      expect(result.refundCents).toBe(priceOf(110, 110, 2));
      expect((await outstandingRefunds(pool))[0]?.reason).toBe("subscription_lapsed");
    });

    /**
     * The safety net. If the cancellation webhook never arrives, an unpaid block
     * still cannot hold its square indefinitely.
     */
    it("sweeps up blocks whose paid period ended, past the grace period", async () => {
      const id = await liveBlock(110, 110, 2, "sub_d", new Date(Date.now() + 86_400_000));
      await pool.query(`UPDATE blocks SET current_period_end = now() - interval '10 days' WHERE id = $1`, [id]);

      const result = await releaseLapsedSubscriptions(pool, 3);

      expect(result.blockIds).toEqual([id]);
      expect(result.tilesReleased).toBe(4);
      expect(await countTiles(pool)).toBe(0);
    });

    it("leaves a block alone while it is still inside the grace period", async () => {
      const id = await liveBlock(110, 110, 2, "sub_e", new Date(Date.now() + 86_400_000));
      await pool.query(`UPDATE blocks SET current_period_end = now() - interval '1 day' WHERE id = $1`, [id]);

      expect(await releaseLapsedSubscriptions(pool, 3)).toEqual({ blockIds: [], tilesReleased: 0 });
      expect(await countTiles(pool)).toBe(4);
    });

    it("is idempotent, so the scheduled sweep can run as often as it likes", async () => {
      const id = await liveBlock(110, 110, 1, "sub_f", new Date(Date.now() + 86_400_000));
      await pool.query(`UPDATE blocks SET current_period_end = now() - interval '10 days' WHERE id = $1`, [id]);

      await releaseLapsedSubscriptions(pool, 3);
      expect(await releaseLapsedSubscriptions(pool, 3)).toEqual({ blockIds: [], tilesReleased: 0 });
    });
  });
});
