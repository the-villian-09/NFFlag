/**
 * Live updates for team spaces. Saving a message calls pg_notify; every API
 * instance LISTENs on one dedicated database connection and forwards each
 * event only to the open streams allowed to see that team (and, for the
 * staff channel, only to staff). Streams re-check membership every minute,
 * so someone removed from a roster stops receiving within a minute.
 */
import type { Response } from "express";
import pg from "pg";
import { env } from "../../config.js";
import { pool } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { liveScopes } from "./membership.js";

const CHANNEL = "team_events";

export interface LiveEvent {
  teamId: string;
  /** team | staff */
  channel: string;
  /** message | delete | pin | rsvp | read */
  type: string;
  id: string;
}

interface Stream {
  userId: string;
  res: Response;
  scopes: Map<string, { staff: boolean }>;
}

const streams = new Set<Stream>();
let listener: pg.Client | null = null;
let connecting: Promise<void> | null = null;
/** Called for each event before it's sent, to attach the full message once. */
let enrich: ((e: LiveEvent) => Promise<unknown>) | null = null;

export function setEnricher(fn: (e: LiveEvent) => Promise<unknown>) {
  enrich = fn;
}

/** Tell every API instance (call after the change is saved). */
export async function broadcast(e: LiveEvent) {
  await pool.query("select pg_notify($1, $2)", [CHANNEL, JSON.stringify(e)]);
}

async function ensureListener() {
  if (listener || connecting) return connecting ?? undefined;
  connecting = (async () => {
    const c = new pg.Client({ connectionString: env.DATABASE_URL });
    c.on("error", (err) => {
      logger.warn({ err: err.message }, "team live listener lost");
      listener = null;
      setTimeout(() => streams.size && void ensureListener(), 2000);
    });
    c.on("notification", (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      void deliver(JSON.parse(n.payload) as LiveEvent);
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    listener = c;
  })()
    .catch((err) => logger.warn({ err: (err as Error).message }, "team live listener failed to start"))
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

async function deliver(e: LiveEvent) {
  const eligible = [...streams].filter((s) => {
    const scope = s.scopes.get(e.teamId);
    return scope && (e.channel !== "staff" || scope.staff);
  });
  if (!eligible.length) return;
  let data: unknown = e;
  if (enrich) {
    try {
      data = (await enrich(e)) ?? e;
    } catch {
      data = e;
    }
  }
  const line = `event: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of eligible) s.res.write(line);
}

/** People with an open stream on this instance (used to skip chat pushes). */
export function onlineUserIds() {
  return new Set([...streams].map((s) => s.userId));
}

/**
 * Serves one live stream. It ends after ~4 minutes (under Cloud Run's request
 * limit) and the browser reconnects by itself.
 */
export async function openStream(userId: string, res: Response) {
  await ensureListener();
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const stream: Stream = { userId, res, scopes: await liveScopes(userId) };
  streams.add(stream);
  res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ teams: [...stream.scopes.keys()] })}\n\n`);

  // A comment every 15 s keeps proxies from closing the connection.
  const beat = setInterval(() => res.write(`: ping\n\n`), 15_000);
  const refresh = setInterval(async () => {
    try {
      stream.scopes = await liveScopes(userId);
    } catch {
      /* keep the last known scopes */
    }
  }, 60_000);
  const end = setTimeout(() => res.end(), 240_000);
  const cleanup = () => {
    clearInterval(beat);
    clearInterval(refresh);
    clearTimeout(end);
    streams.delete(stream);
  };
  res.on("close", cleanup);
}

/** For tests: close the listener. */
export async function closeLive() {
  for (const s of streams) s.res.end();
  streams.clear();
  if (listener) await listener.end().catch(() => {});
  listener = null;
}
