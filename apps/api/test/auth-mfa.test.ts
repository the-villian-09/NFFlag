import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, outboxEvents, user } from "../src/db/schema/index.js";
import {
  agent,
  codeFromEmail,
  confirmEmail,
  enrollEmailMfa,
  enrollTotp,
  mail,
  PASSWORD,
  signUp,
  totpFromUri,
  uniqueEmail,
} from "./helpers.js";

describe("sign-up with email confirmation", () => {
  it("emails a confirmation link and blocks sign-in until it is clicked", async () => {
    const a = agent();
    const email = uniqueEmail("unconfirmed");
    const res = await a.post("/api/auth/sign-up/email").send({ email, password: PASSWORD, name: "New Parent" });
    expect(res.status).toBe(200);
    expect(mail.last(email, "auth.verify_email")).toBeDefined();
    expect((await a.get("/api/v1/me")).status).toBe(401);

    // Signing in before confirming is refused and re-sends the link.
    const sentBefore = mail.sent.filter((m) => m.to === email).length;
    const signIn = await agent().post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(signIn.status).toBe(403);
    expect(signIn.body.code).toBe("EMAIL_NOT_VERIFIED"); // the web sign-in page relies on this code
    expect(mail.sent.filter((m) => m.to === email).length).toBe(sentBefore + 1);

    // Clicking the link confirms and signs in.
    await confirmEmail(a, email);
    expect((await a.get("/api/v1/me")).status).toBe(200);
  });

  it("signs the family in after confirming, with two-step sign-in off by default", async () => {
    const a = agent();
    const email = uniqueEmail("parent");
    await signUp(a, email);

    const me = await a.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.mfa).toMatchObject({ required: "none", complete: true, enabled: false });

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

  it("lets a family without two-step sign-in sign in with just a password", async () => {
    const email = uniqueEmail("plain");
    await signUp(agent(), email);
    const device = agent();
    const res = await device.post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRedirect).toBeUndefined();
    expect((await device.get("/api/v1/me")).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const email = uniqueEmail("wrongpw");
    await signUp(agent(), email);
    const res = await agent().post("/api/auth/sign-in/email").send({ email, password: "not-the-password" });
    expect(res.status).toBe(401);
  });
});

describe("optional two-step sign-in", () => {
  it("with emailed codes: asks on a new device, skips on a trusted device for 30 days", async () => {
    const email = uniqueEmail("trusted");
    const first = agent();
    await signUp(first, email);
    await enrollEmailMfa(first, email);
    expect((await first.get("/api/v1/me")).body.mfa.enabled).toBe(true);

    // New device: password alone does not create a session.
    const device = agent();
    const signIn = await device.post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect((await device.get("/api/v1/me")).status).toBe(401);

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
    expect(again.body.twoFactorRedirect).toBeUndefined();
    expect((await device.get("/api/v1/me")).status).toBe(200);
  });

  it("with an authenticator app: asks for its code at sign-in", async () => {
    const email = uniqueEmail("app-user");
    const a = agent();
    await signUp(a, email);
    const { uri, backupCodes } = await enrollTotp(a);
    expect(backupCodes).toHaveLength(10);

    const device = agent();
    const signIn = await device.post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    const ok = await device.post("/api/auth/two-factor/verify-totp").send({ code: totpFromUri(uri) });
    expect(ok.status).toBe(200);
    expect((await device.get("/api/v1/me")).body.mfa).toMatchObject({ enabled: true, totpEnrolled: true });
  });

  it("can be turned off again by the user", async () => {
    const email = uniqueEmail("turn-off");
    const a = agent();
    await signUp(a, email);
    await enrollEmailMfa(a, email);
    const off = await a.post("/api/auth/two-factor/disable").send({ password: PASSWORD });
    expect(off.status).toBe(200);
    expect((await a.get("/api/v1/me")).body.mfa.enabled).toBe(false);

    const res = await agent().post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(res.body.twoFactorRedirect).toBeUndefined();
  });
});

describe("account safety", () => {
  it("rejects disabled accounts", async () => {
    const email = uniqueEmail("disabled");
    await signUp(agent(), email);
    await db.update(user).set({ status: "disabled" }).where(eq(user.email, email));
    const res = await agent().post("/api/auth/sign-in/email").send({ email, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it("sends password reset emails", async () => {
    const email = uniqueEmail("reset");
    await signUp(agent(), email);
    const res = await agent()
      .post("/api/auth/request-password-reset")
      .send({ email, redirectTo: "http://localhost:3000/reset-password" });
    expect(res.status).toBe(200);
    expect(mail.last(email, "auth.reset_password")).toBeDefined();
  });
});
