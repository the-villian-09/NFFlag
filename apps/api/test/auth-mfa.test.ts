import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, outboxEvents, user } from "../src/db/schema/index.js";
import { agent, codeFromEmail, enrollEmailMfa, mail, PASSWORD, signUpVerified, uniqueEmail } from "./helpers.js";

describe("parent sign-up and email-code MFA", () => {
  it("requires email verification before sign-in", async () => {
    const a = agent();
    const email = uniqueEmail("unverified");
    await a.post("/api/auth/sign-up/email").send({ email, password: PASSWORD, name: "No Verify" });
    const signIn = await agent().post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(signIn.status).toBe(403);
  });

  it("blocks app routes until MFA is set up, then allows them", async () => {
    const a = agent();
    const email = uniqueEmail("parent");
    await signUpVerified(a, email);

    const me1 = await a.get("/api/v1/me");
    expect(me1.status).toBe(200);
    expect(me1.body.mfa).toMatchObject({ required: "email", complete: false });

    const blocked = await a.get("/api/v1/households/me");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("MFA_ENROLLMENT_REQUIRED");
    expect(blocked.body.error.required).toBe("email");

    await enrollEmailMfa(a, email);

    const me2 = await a.get("/api/v1/me");
    expect(me2.body.mfa).toMatchObject({ required: "email", complete: true });

    const created = await a.post("/api/v1/households").send({ displayName: "The Testers", state: "FL" });
    expect(created.status).toBe(201);
    const householdId = created.body.household.id;

    // Audit + outbox written in the same transaction.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetType, "household"), eq(auditLogs.targetId, householdId)));
    expect(audit).toHaveLength(1);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, householdId));
    expect(events.map((e) => e.eventName)).toEqual(["household.created"]);
  });

  it("asks for an emailed code on a new device, and skips it on a trusted device for 30 days", async () => {
    const email = uniqueEmail("trusted");
    const first = agent();
    await signUpVerified(first, email);
    await enrollEmailMfa(first, email);

    // New device: password alone does not create a session.
    const device = agent();
    const signIn = await device.post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await device.get("/api/v1/me")).status).toBe(401);

    // Wrong code is rejected.
    await device.post("/api/auth/two-factor/send-otp").send({});
    const wrong = await device.post("/api/auth/two-factor/verify-otp").send({ code: "000000" });
    expect(wrong.status).toBe(401);

    await device.post("/api/auth/two-factor/send-otp").send({});
    const ok = await device
      .post("/api/auth/two-factor/verify-otp")
      .send({ code: codeFromEmail(email), trustDevice: true });
    expect(ok.status).toBe(200);
    expect((await device.get("/api/v1/me")).status).toBe(200);

    // Same device, sign out and back in: trusted, no code needed.
    await device.post("/api/auth/sign-out").send({});
    const again = await device.post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(again.status).toBe(200);
    expect(again.body.twoFactorRedirect).toBeUndefined();
    expect((await device.get("/api/v1/me")).status).toBe(200);
  });

  it("rejects disabled accounts", async () => {
    const email = uniqueEmail("disabled");
    const a = agent();
    await signUpVerified(a, email);
    await db.update(user).set({ status: "disabled" }).where(eq(user.email, email));
    const res = await agent().post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("sends password reset emails", async () => {
    const email = uniqueEmail("reset");
    await signUpVerified(agent(), email);
    const res = await agent()
      .post("/api/auth/request-password-reset")
      .send({ email, redirectTo: "http://localhost:3000/reset-password" });
    expect(res.status).toBe(200);
    expect(mail.last(email, "auth.reset_password")).toBeDefined();
  });
});
