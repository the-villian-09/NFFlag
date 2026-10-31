import type { RoleKey } from "@nffl/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, roles, sessionActivity, user, userRoleAssignments } from "../src/db/schema/index.js";
import { agent, enrollEmailMfa, enrollTotp, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

async function grant(email: string, role: RoleKey) {
  const [u] = await db.select().from(user).where(eq(user.email, email));
  await db.insert(userRoleAssignments).values({ userId: u!.id, roleKey: role });
  return u!.id;
}

describe("admin access", () => {
  let adminEmail: string;
  let admin: Agent;
  let adminId: string;

  beforeAll(async () => {
    adminEmail = uniqueEmail("admin");
    admin = agent();
    await signUp(admin, adminEmail, "League Admin");
    adminId = await grant(adminEmail, "super_admin");
  });

  afterAll(async () => {
    await db.update(roles).set({ requiresTotp: false });
  });

  it("lets admins in without two-step sign-in by default", async () => {
    const me = await admin.get("/api/v1/me");
    expect(me.body.mfa).toMatchObject({ required: "none", complete: true });
    expect((await admin.get("/api/v1/admin/flags")).status).toBe(200);
  });

  it("adds regular Admins who can run the league but not payments setup or admin management; one Super Admin", async () => {
    const email = uniqueEmail("helper");
    const helper = agent();
    await signUp(helper, email, "Helper Admin");
    const [u] = await db.select().from(user).where(eq(user.email, email));

    expect((await admin.post(`/api/v1/admin/users/${u!.id}/roles`).send({ role: "super_admin" })).status).toBe(409);
    const g = await admin.post(`/api/v1/admin/users/${u!.id}/roles`).send({ role: "league_admin" });
    expect(g.status).toBe(201);
    const list = (await admin.get("/api/v1/admin/admins")).body.items as { email: string; roleKey: string }[];
    expect(list.find((r) => r.email === email)?.roleKey).toBe("league_admin");

    expect((await helper.get("/api/v1/admin/league/registrations")).status).toBe(200);
    expect((await helper.get("/api/v1/admin/payments")).status).toBe(200);
    expect((await helper.put("/api/v1/admin/league/payment-settings").send({})).status).toBe(403);
    expect((await helper.post("/api/v1/admin/payments/square/connect")).status).toBe(403);
    expect((await helper.post("/api/v1/admin/payments/square/disconnect")).status).toBe(403);
    expect((await helper.get("/api/v1/admin/admins")).status).toBe(403);
    expect((await helper.post(`/api/v1/admin/users/${u!.id}/roles`).send({ role: "league_admin" })).status).toBe(403);

    expect((await admin.delete(`/api/v1/admin/users/${u!.id}/roles/${g.body.assignment.id}`)).status).toBe(204);
    expect((await helper.get("/api/v1/admin/league/registrations")).status).toBe(403);
  });

  it("audits feature-flag changes and exposes enabled flags publicly", async () => {
    const res = await admin.put("/api/v1/admin/flags/r1b.registration").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.flag.enabled).toBe(true);
    const pub = await agent().get("/api/v1/flags");
    expect(pub.body.enabled).toContain("r1b.registration");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.targetId, "r1b.registration"));
    expect(audit.some((a) => a.actorUserId === adminId && a.action.includes("flag"))).toBe(true);
  });

  it("can require an authenticator app for a role, enforced until the user sets one up", async () => {
    const leagueEmail = uniqueEmail("league-admin");
    const leagueAdmin = agent();
    await signUp(leagueAdmin, leagueEmail);
    await grant(leagueEmail, "league_admin");
    expect((await leagueAdmin.get("/api/v1/admin/audit")).status).toBe(200);

    const set = await admin.put("/api/v1/admin/roles/league_admin/mfa").send({ requiresTotp: true });
    expect(set.status).toBe(200);
    expect(set.body.role.requiresTotp).toBe(true);

    const blocked = await leagueAdmin.get("/api/v1/admin/audit");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatchObject({ code: "MFA_ENROLLMENT_REQUIRED", required: "totp" });

    // Email codes don't satisfy that rule, and none is sent.
    const before = mail.sent.length;
    await leagueAdmin.post("/api/auth/two-factor/send-otp").send({});
    expect(mail.sent.length).toBe(before);

    await enrollTotp(leagueAdmin);
    expect((await leagueAdmin.get("/api/v1/admin/audit")).status).toBe(200);

    // Super Admin role unaffected.
    expect((await admin.get("/api/v1/admin/flags")).status).toBe(200);
    await admin.put("/api/v1/admin/roles/league_admin/mfa").send({ requiresTotp: false });
  });

  it("forbids parents from admin routes", async () => {
    const p = agent();
    await signUp(p, uniqueEmail("nosy-parent"));
    const res = await p.get("/api/v1/admin/flags");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("does not let one family see another family's household", async () => {
    const a = agent();
    await signUp(a, uniqueEmail("fam-a"));
    await a.post("/api/v1/households").send({ displayName: "Family A" });

    const b = agent();
    await signUp(b, uniqueEmail("fam-b"));
    const res = await b.get("/api/v1/households/me");
    expect(res.status).toBe(404);
  });

  it("lets a Super Admin reset another user's two-step sign-in, with a reason, and signs them out", async () => {
    const email = uniqueEmail("locked-out");
    const victim = agent();
    await signUp(victim, email);
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
