/**
 * POST /internal/tick: Cloud Scheduler's once-a-minute worker run inside the API.
 * Tokens are signed with a local key standing in for Google's.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { pool } from "../src/db/client.js";
import { setTickKeys } from "../src/modules/platform/tick.js";
import { publish } from "../src/modules/platform/outbox.js";
import { db } from "../src/db/client.js";
import { agent } from "./helpers.js";

const SA = "nffl-scheduler@nffl-test.iam.gserviceaccount.com";
const AUD = "https://nffl-api-test.a.run.app";
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string }) => Promise<string>;
let otherKeySign: () => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = "test";
  jwk.alg = "RS256";
  setTickKeys(createLocalJWKSet({ keys: [jwk] }));
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(opts.iss ?? "https://accounts.google.com")
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const other = await generateKeyPair("RS256");
  otherKeySign = () =>
    new SignJWT({ email: SA, email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://accounts.google.com")
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(other.privateKey);
  env.WORKER_TICK_SA = SA;
  env.WORKER_TICK_AUDIENCE = AUD;
});
afterAll(() => {
  env.WORKER_TICK_SA = undefined;
  env.WORKER_TICK_AUDIENCE = undefined;
});

const tick = (token?: string) => {
  const r = agent().post("/internal/tick");
  return token ? r.set("authorization", `Bearer ${token}`) : r;
};

describe("worker tick", () => {
  it("is off (404) until configured", async () => {
    env.WORKER_TICK_SA = undefined;
    expect((await tick(await sign({ email: SA, email_verified: true }))).status).toBe(404);
    env.WORKER_TICK_SA = SA;
  });

  it("refuses anything but the scheduler's Google token", async () => {
    expect((await tick()).status).toBe(401);
    expect((await tick("not-a-token")).status).toBe(401);
    expect((await tick(await sign({ email: "someone@example.com", email_verified: true }))).status).toBe(401);
    expect((await tick(await sign({ email: SA, email_verified: false }))).status).toBe(401);
    expect((await tick(await sign({ email: SA, email_verified: true }, { aud: "https://evil.example" }))).status).toBe(401);
    expect((await tick(await sign({ email: SA, email_verified: true }, { iss: "https://evil.example" }))).status).toBe(401);
    expect((await tick(await otherKeySign())).status).toBe(401);
  });

  it("runs a worker pass for the scheduler and handles queued events", async () => {
    await publish(db, { name: "user.registered", aggregateType: "user", aggregateId: "tick-test", dedupeKey: `tick:${Date.now()}` });
    const res = await tick(await sign({ email: SA, email_verified: true }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBeGreaterThanOrEqual(1);
  });

  it("skips when another pass holds the lock (job and tick never overlap)", async () => {
    const c = await pool.connect();
    try {
      await c.query("select pg_advisory_lock($1)", [4_711_202_611]);
      const res = await tick(await sign({ email: SA, email_verified: true }));
      expect(res.status).toBe(200);
      expect(res.body.skipped).toBeTruthy();
    } finally {
      await c.query("select pg_advisory_unlock($1)", [4_711_202_611]);
      c.release();
    }
  });

  it("stays reachable when the API only answers the website", async () => {
    env.API_PROXY_SECRET = "s".repeat(40);
    try {
      expect((await tick()).status).toBe(401); // reached the route, not the guard's 404
    } finally {
      env.API_PROXY_SECRET = undefined;
    }
  });
});

describe("worker pass time limit", () => {
  it("stops after its time budget and leaves the rest for the next pass", async () => {
    const { runWorkerPass } = await import("../src/modules/platform/worker-pass.js");
    await runWorkerPass(); // start from an empty queue
    const stamp = Date.now();
    for (let i = 0; i < 70; i++) {
      await publish(db, { name: "user.registered", aggregateType: "user", aggregateId: `budget-${i}`, dedupeKey: `budget:${stamp}:${i}` });
    }
    // No time left: one batch only.
    const first = await runWorkerPass(0);
    expect(first).toMatchObject({ processed: 50, more: true });
    const second = await runWorkerPass();
    expect(second).toMatchObject({ processed: 20, more: false });
  });
});
