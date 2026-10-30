import type { RoleKey } from "@nffl/shared";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, sessionActivity, user, userRoleAssignments } from "../src/db/schema/index.js";
import {
  agent,
  enrollEmailMfa,
  enrollTotp,
  mail,
  PASSWORD,
  signUpVerified,
  totpFromUri,
  uniqueEmail,
  type Agent,
} from "./helpers.js";

async function grant(email: string, role: RoleKey) {
  const [u] = await db.select().from(user).where(eq(user.email, email));
  await db.insert(userRoleAssignments).values({ userId: u!.id, roleKey: role });
  return u!.id;
}

describe("admin access", () => {
  let adminEmail: string;
  let admin: Agent;
  let adminId: string;
  let totpUri: string;

  beforeAll(async () => {
    adminEmail = uniqueEmail("admin");
    admin = agent();
    await signUpVerified(admin, adminEmail, "League Admin");
    adminId = await grant(adminEmail, "super_admin");
  });

  it("requires an authenticator app (not email codes) for staff", async () => {
    const me = await admin.get("/api/v1/me");
    expect(me.body.mfa).toMatchObject({ required: "totp", complete: false });
    const blocked = await admin.get("/api/v1/admin/flags");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.required).toBe("totp");

    // Email-code enrollment does not satisfy staff policy, and no code is emailed.
    const before = mail.sent.length;
    await admin.post("/api/auth/two-factor/send-otp").send({});
    expect(mail.sent.length).toBe(before);
  });

  it("allows the admin portal once TOTP is confirmed", async () => {
    const { uri, backupCodes } = await enrollTotp(admin);
    totpUri = uri;
    expect(backupCodes).toHaveLength(10);
    const me = await admin.get("/api/v1/me");
    expect(me.body.mfa).toMatchObject({ required: "totp", complete: true, totpEnrolled: true });
    const flags = await admin.get("/api/v1/admin/flags");
    expect(flags.status).toBe(200);
    expect(flags.body.items.length).toBeGreaterThan(5);
  });

  it("asks staff for an authenticator code at every new sign-in", async () => {
    const device = agent();
    const signIn = await device.post("/api/auth/sign-in/email").send({ email: adminEmail, password: PASSWORD });
    expect(signIn.body.twoFactorRedirect).toBe(true);
    const ok = await device.post("/api/auth/two-factor/verify-totp").send({ code: totpFromUri(totpUri) });
    expect(ok.status).toBe(200);
    expect((await device.get("/api/v1/admin/flags")).status).toBe(200);
  });

  it("audits feature-flag changes and exposes enabled flags publicly", async () => {
    const res = await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.flag.enabled).toBe(true);
    const pub = await agent().get("/api/v1/flags");
    expect(pub.body.enabled).toContain("r1b.registration");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.targetId, "r1b.registration"));
    expect(audit[0]?.actorUserId).toBe(adminId);
  });

  it("forbids parents from admin routes", async () => {
    const email = uniqueEmail("nosy-parent");
    const p = agent();
    await signUpVerified(p, email);
    await enrollEmailMfa(p, email);
    const res = await p.get("/api/v1/admin/flags");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("does not let one family see another family's household", async () => {
    const aEmail = uniqueEmail("fam-a");
    const a = agent();
    await signUpVerified(a, aEmail);
    await enrollEmailMfa(a, aEmail);
    await a.post("/api/v1/households").send({ displayName: "Family A" });

    const bEmail = uniqueEmail("fam-b");
    const b = agent();
    await signUpVerified(b, bEmail);
    await enrollEmailMfa(b, bEmail);
    const res = await b.get("/api/v1/households/me");
    expect(res.status).toBe(404);
  });

  it("lets a Super Admin reset another user's MFA, with a reason, and signs them out", async () => {
    const email = uniqueEmail("locked-out");
    const victim = agent();
    await signUpVerified(victim, email);
    await enrollEmailMfa(victim, email);
    const [u] = await db.select().from(user).where(eq(user.email, email));

    const noReason = await admin.post(`/api/v1/admin/users/${u!.id}/mfa-reset`).send({});
    expect(noReason.status).toBe(400);

    const ok = await admin.post(`/api/v1/admin/users/${u!.id}/mfa-reset`).send({ reason: "Lost phone, verified by call" });
    expect(ok.status).toBe(204);
    expect((await victim.get("/api/v1/me")).status).toBe(401);
    const [after] = await db.select().from(user).where(eq(user.id, u!.id));
    expect(after!.twoFactorEnabled).toBe(false);
  });

  it("won't remove the last Super Admin", async () => {
    const [row] = await db.select().from(userRoleAssignments).where(eq(userRoleAssignments.userId, adminId));
    const res = await admin.delete(`/api/v1/admin/users/${adminId}/roles/${row!.id}`);
    expect(res.status).toBe(409);
  });

  it("signs out an idle admin session", async () => {
    await db.execute(sql`update ${sessionActivity} set last_seen_at = now() - interval '2 hours'`);
    const res = await admin.get("/api/v1/admin/flags");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("SESSION_IDLE");
  });

  it("keeps the audit log append-only", async () => {
    const blocked = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await expect(db.execute(sql`update ${auditLogs} set action = 'tampered'`)).rejects.toMatchObject(blocked);
    await expect(db.execute(sql`delete from ${auditLogs}`)).rejects.toMatchObject(blocked);
  });
});
