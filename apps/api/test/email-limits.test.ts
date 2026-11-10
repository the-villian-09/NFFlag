import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { contactMessages, emailQuota } from "../src/db/schema/index.js";
import { cleanupEmailQuota, DAILY_EMAIL_LIMITS, takeEmailQuota } from "../src/lib/email-quota.js";
import { agent, mail, signUp, uniqueEmail } from "./helpers.js";

const sentTo = (to: string, template: string) => mail.sent.filter((m) => m.to === to && m.template === template).length;

describe("daily per-address email limits", () => {
  it("stops reset emails after the daily limit, answering the same way", async () => {
    const email = uniqueEmail("reset-limit");
    await signUp(agent(), email);
    for (let i = 0; i < DAILY_EMAIL_LIMITS.reset + 2; i++) {
      // Mixed case and spaces still count against the same address.
      const typed = i % 2 ? email.toUpperCase() : email;
      const res = await agent().post("/api/auth/request-password-reset").send({ email: typed, redirectTo: "http://localhost:3000/reset-password" });
      expect(res.status).toBe(200);
    }
    expect(sentTo(email, "auth.reset_password")).toBe(DAILY_EMAIL_LIMITS.reset);
  });

  it("stops confirmation emails after the daily limit", async () => {
    const email = uniqueEmail("verify-limit");
    const a = agent();
    expect((await a.post("/api/auth/sign-up/email").send({ email, password: "correct-horse-battery", name: "Pat" })).status).toBe(200);
    for (let i = 0; i < DAILY_EMAIL_LIMITS.verify + 2; i++) {
      const res = await agent().post("/api/auth/send-verification-email").send({ email });
      expect(res.status).toBe(200);
    }
    expect(sentTo(email, "auth.verify_email")).toBe(DAILY_EMAIL_LIMITS.verify);
  });

  it("keeps the count in the database, so a restart doesn't reset it", async () => {
    const email = uniqueEmail("quota-db");
    for (let i = 0; i < DAILY_EMAIL_LIMITS.login_code; i++) expect(await takeEmailQuota(email, "login_code")).toBe(true);
    expect(await takeEmailQuota(email, "login_code")).toBe(false);
    const [row] = await db.select().from(emailQuota).where(and(eq(emailQuota.address, email), eq(emailQuota.kind, "login_code")));
    expect(row!.count).toBe(DAILY_EMAIL_LIMITS.login_code + 1);
    // Other kinds have their own count.
    expect(await takeEmailQuota(email, "reset")).toBe(true);
  });

  it("takes a few contact messages a day from one sender, then quietly drops them", async () => {
    const email = uniqueEmail("contact-limit");
    for (let i = 0; i < DAILY_EMAIL_LIMITS.contact + 2; i++) {
      const res = await agent().post("/api/v1/contact").send({ name: "Pat", email, message: `Question number ${i}` });
      expect(res.status).toBe(202);
    }
    const stored = await db.select().from(contactMessages).where(eq(contactMessages.email, email));
    expect(stored).toHaveLength(DAILY_EMAIL_LIMITS.contact);
  });

  it("the worker deletes counts older than two days", async () => {
    const email = uniqueEmail("quota-old");
    await db.insert(emailQuota).values({ address: email, kind: "reset", day: sql`(now() at time zone 'utc')::date - 3`, count: 2 });
    await db.insert(emailQuota).values({ address: email, kind: "verify", day: sql`(now() at time zone 'utc')::date`, count: 1 });
    expect(await cleanupEmailQuota()).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(emailQuota).where(eq(emailQuota.address, email));
    expect(left.map((r) => r.kind)).toEqual(["verify"]);
  });
});
