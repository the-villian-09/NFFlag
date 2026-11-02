/** Admin portal: "Needs attention" counts and people search, limited to what each admin may see. */
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { divisions, households, players, registrations, seasons, user, userRoleAssignments, withdrawalRequests } from "../src/db/schema/index.js";
import { agent, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let helper: Agent;
let helperId: string;
let seasonId: string;
let regId: string;
let previousCurrent: string | null = null;

async function person(prefix: string, name: string) {
  const a = agent();
  const email = uniqueEmail(prefix);
  await signUp(a, email, name);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, id: u!.id, email };
}

beforeAll(async () => {
  const s = await person("portal-admin", "Portal Admin");
  admin = s.a;
  adminId = s.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const h = await person("portal-helper", "Portal Helper");
  helper = h.a;
  helperId = h.id;
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  await db.update(seasons).set({ isCurrent: null });
  const [season] = await db.insert(seasons).values({ name: "Portal Season", year: 2027, status: "registration_open", isCurrent: "current" }).returning();
  seasonId = season!.id;
  const [d] = await db.insert(divisions).values({ seasonId, name: "Portal 10U", capacity: 10, priceCents: 10000, status: "open" }).returning();
  const [fam] = await db.insert(households).values({ displayName: "The Zebulon Family" }).returning();
  const [p] = await db.insert(players).values({ householdId: fam!.id, firstName: "Quincy", lastName: "Zebulon", birthDate: "2016-03-03", gender: "boy" }).returning();
  const [r] = await db
    .insert(registrations)
    .values({ seasonId, divisionId: d!.id, playerId: p!.id, householdId: fam!.id, status: "paid", priceCents: 10000, totalCents: 10000 })
    .returning();
  regId = r!.id;
  await db.insert(withdrawalRequests).values({ registrationId: regId, reason: "Moving" });
});

afterAll(async () => {
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  else await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, helperId));
});

describe("admin portal", () => {
  it("summary lists what needs attention", async () => {
    const res = await admin.get("/api/v1/admin/summary");
    expect(res.status).toBe(200);
    const keys = res.body.items.map((i: { key: string }) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["registrations", "withdrawals"]));
    const reg = res.body.items.find((i: { key: string }) => i.key === "registrations");
    expect(reg).toMatchObject({ count: 1, label: "registration to review", href: "/admin/registrations" });
  });

  it("search finds a player by first and last name, and a family by name", async () => {
    const res = await admin.get("/api/v1/admin/search?q=zebulon quincy");
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ type: "player", label: "Quincy Zebulon", href: `/admin/registrations/${regId}` });
    expect(res.body.items[0].detail).toContain("Needs review");
    const fam = await admin.get("/api/v1/admin/search?q=zebul");
    expect(fam.body.items.some((i: { type: string; label: string }) => i.type === "family" && i.label === "The Zebulon Family")).toBe(true);
    expect((await admin.get("/api/v1/admin/search?q=z")).status).toBe(400);
    // Wildcards are taken literally.
    expect((await admin.get("/api/v1/admin/search?q=%25%25")).body.items).toEqual([]);
  });

  it("is admins only, and each admin sees only what their permissions allow", async () => {
    expect((await helper.get("/api/v1/admin/summary")).status).toBe(403);
    expect((await helper.get("/api/v1/admin/search?q=zebulon")).status).toBe(403);
    await db.insert(userRoleAssignments).values({ userId: helperId, roleKey: "scorekeeper" });
    // A scorekeeper can enter scores but can't see families.
    const s = await helper.get("/api/v1/admin/search?q=zebulon");
    expect(s.status).toBe(200);
    expect(s.body.items).toEqual([]);
    const sum = await helper.get("/api/v1/admin/summary");
    expect(sum.body.items).toEqual([]);
  });
});
