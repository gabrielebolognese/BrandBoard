import type { Pool } from "pg";

/**
 * Recording webhook deliveries, once.
 *
 * Providers retry, so the same event arrives more than once and a handler that
 * simply ran again would publish a block twice or refund twice. The unique key
 * on (provider, event_id) settles it at the storage layer: the second delivery
 * cannot insert, and a handler that inserts before it acts therefore cannot act
 * twice, however the two deliveries are interleaved.
 *
 * This is the same shape as occupied_tiles. Correctness comes from a key the
 * database refuses to duplicate, not from a read that could be raced.
 */

export interface RecordedEvent {
  readonly id: string;
  /** True when this delivery has been seen before. Do nothing and acknowledge. */
  readonly duplicate: boolean;
}

export async function recordWebhookEvent(
  pool: Pool,
  event: {
    provider: string;
    eventId: string;
    eventType: string;
    payload: unknown;
  },
): Promise<RecordedEvent> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (provider, event_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING id`,
    [event.provider, event.eventId, event.eventType, JSON.stringify(event.payload)],
  );

  const row = inserted.rows[0];
  if (row !== undefined) return { id: row.id, duplicate: false };

  // The conflict means someone already recorded this delivery. Hand back the
  // original row so a caller can point at it in a log.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_events WHERE provider = $1 AND event_id = $2`,
    [event.provider, event.eventId],
  );
  const found = existing.rows[0];
  if (found === undefined) throw new Error("webhook event vanished between insert and read");
  return { id: found.id, duplicate: true };
}

/** Notes what the handler decided, so support can answer "what happened to my order". */
export async function markEventProcessed(
  pool: Pool,
  id: string,
  outcome: string,
): Promise<void> {
  await pool.query(
    `UPDATE webhook_events SET processed_at = now(), outcome = $2 WHERE id = $1`,
    [id, outcome.slice(0, 500)],
  );
}

/** Deliveries that were recorded but never finished. Something went wrong in these. */
export async function unprocessedEvents(
  pool: Pool,
  limit = 50,
): Promise<Array<{ id: string; eventType: string; receivedAt: Date }>> {
  const result = await pool.query<{ id: string; event_type: string; received_at: Date }>(
    `SELECT id, event_type, received_at
       FROM webhook_events
      WHERE processed_at IS NULL
      ORDER BY received_at
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    receivedAt: row.received_at,
  }));
}
