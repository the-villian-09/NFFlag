import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { outboxEvents } from "../src/db/schema/index.js";
import { can, type Access } from "../src/modules/platform/access.js";
import { redact } from "../src/modules/platform/audit.js";
import { clearSubscribers, processOutbox, publish, subscribe } from "../src/modules/platform/outbox.js";
import { agent } from "./helpers.js";

describe("permissions", () => {
  const team = { type: "team" as const, id: "11111111-1111-1111-1111-111111111111" };
  const otherTeam = { type: "team" as const, id: "22222222-2222-2222-2222-222222222222" };
  const coach: Access = {
    userId: "u1",
    roles: ["head_coach"],
    grants: [{ role: "head_coach", scope: team, permissions: new Set(["roster.read"]) }],
    leagueWide: new Set(),
    requiresTotp: true,
    hasVerifiedTotp: true,
  };

  it("limits scoped grants to their own team", () => {
    expect(can(coach, "roster.read", team)).toBe(true);
    expect(can(coach, "roster.read", otherTeam)).toBe(false);
    expect(can(coach, "roster.read")).toBe(false);
    expect(can(coach, "refunds.issue", team)).toBe(false);
  });

  it("lets league-wide grants cover every scope", () => {
    const admin: Access = { ...coach, leagueWide: new Set(["roster.read"]), grants: [] };
    expect(can(admin, "roster.read", otherTeam)).toBe(true);
  });
});

describe("audit redaction", () => {
  it("removes secrets and medical fields at any depth", () => {
    expect(redact({ name: "A", password: "x", child: { allergies: "peanuts", jersey: "YM" } })).toEqual({
      name: "A",
      password: "[redacted]",
      child: { allergies: "[redacted]", jersey: "YM" },
    });
  });
});

describe("outbox", () => {
  afterEach(() => clearSubscribers());

  it("delivers once, ignores duplicate publishes, and retries failures", async () => {
    const seen: string[] = [];
    let failOnce = true;
    subscribe("registration.paid", async (e) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("provider down");
      }
      seen.push(e.aggregateId);
    });

    await publish(db, { name: "registration.paid", aggregateType: "registration", aggregateId: "reg-1", dedupeKey: "sq:evt-1" });
    await publish(db, { name: "registration.paid", aggregateType: "registration", aggregateId: "reg-1", dedupeKey: "sq:evt-1" });
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, "sq:evt-1"));
    expect(rows).toHaveLength(1);

    const first = await processOutbox();
    expect(first.failed).toBe(1);
    expect(seen).toEqual([]);

    // Make it due now instead of waiting for backoff.
    await db.update(outboxEvents).set({ availableAt: new Date() }).where(eq(outboxEvents.id, rows[0]!.id));
    await processOutbox();
    expect(seen).toEqual(["reg-1"]);

    const [done] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, rows[0]!.id));
    expect(done!.processedAt).not.toBeNull();
    expect(done!.attempts).toBe(2);
  });
});

describe("public endpoints", () => {
  it("reports health and readiness", async () => {
    expect((await agent().get("/api/v1/health")).body).toEqual({ ok: true });
    expect((await agent().get("/api/v1/ready")).status).toBe(200);
  });

  it("hides draft divisions from the public season view", async () => {
    const res = await agent().get("/api/v1/seasons/current");
    expect(res.status).toBe(200);
    expect(res.body.season.name).toContain("2027");
    expect(res.body.divisions).toEqual([]);
  });

  it("returns stable JSON errors with a request id", async () => {
    const res = await agent().get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });
});
