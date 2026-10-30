/**
 * Transactional outbox. Modules call `publish()` inside their DB transaction;
 * `processOutbox()` (run by the worker / Cloud Scheduler) delivers events to
 * subscribers. Later releases add subscribers, not changes to publishers.
 */
import type { DomainEventName } from "@nffl/shared";
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "../../db/client.js";
import { outboxEvents } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";

export interface DomainEvent<P = Record<string, unknown>> {
  name: DomainEventName;
  aggregateType: string;
  aggregateId: string;
  payload?: P;
  /** Set to make publishing idempotent (e.g. `square:${eventId}`). */
  dedupeKey?: string;
}

export async function publish(conn: DbOrTx, event: DomainEvent) {
  await conn
    .insert(outboxEvents)
    .values({
      eventName: event.name,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload ?? {},
      dedupeKey: event.dedupeKey ?? null,
    })
    .onConflictDoNothing({ target: outboxEvents.dedupeKey });
}

export type Subscriber = (event: {
  id: string;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}) => Promise<void>;

const subscribers = new Map<string, Subscriber[]>();

/** Register a handler. Handlers must be idempotent: delivery is at-least-once. */
export function subscribe(eventName: DomainEventName, handler: Subscriber) {
  const list = subscribers.get(eventName) ?? [];
  list.push(handler);
  subscribers.set(eventName, list);
}

export function clearSubscribers() {
  subscribers.clear();
}

const MAX_ATTEMPTS = 8;

/**
 * Claims a batch with SKIP LOCKED so several workers can run safely, runs
 * subscribers, and marks each event done, retried with backoff, or dead.
 */
export async function processOutbox(batchSize = 25): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  await db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      id: string;
      event_name: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
      attempts: number;
    }>(sql`
      select id, event_name, aggregate_type, aggregate_id, payload, attempts
      from ${outboxEvents}
      where processed_at is null and dead_at is null and available_at <= now()
      order by created_at
      limit ${batchSize}
      for update skip locked
    `);

    for (const row of claimed.rows) {
      const handlers = subscribers.get(row.event_name) ?? [];
      try {
        for (const h of handlers) {
          await h({
            id: row.id,
            eventName: row.event_name,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            payload: row.payload,
          });
        }
        await tx.execute(sql`update ${outboxEvents} set processed_at = now(), attempts = attempts + 1 where id = ${row.id}`);
        processed++;
      } catch (err) {
        failed++;
        const attempts = row.attempts + 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ eventId: row.id, eventName: row.event_name, attempts, err: message }, "outbox handler failed");
        if (attempts >= MAX_ATTEMPTS) {
          await tx.execute(
            sql`update ${outboxEvents} set attempts = ${attempts}, last_error = ${message}, dead_at = now() where id = ${row.id}`,
          );
        } else {
          const backoffSeconds = Math.min(3600, 2 ** attempts * 15);
          await tx.execute(sql`
            update ${outboxEvents}
            set attempts = ${attempts}, last_error = ${message},
                available_at = now() + make_interval(secs => ${backoffSeconds})
            where id = ${row.id}`);
        }
      }
    }
  });
  return { processed, failed };
}
