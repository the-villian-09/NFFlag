import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import {
  divisions,
  formResponses,
  forms,
  householdMembers,
  households,
  players,
  registrations,
  seasons,
  user,
  userRoleAssignments,
} from "../src/db/schema/index.js";
import { clearSubscribers, processOutbox } from "../src/modules/platform/outbox.js";
import { registerSubscribers } from "../src/modules/subscribers.js";
import { featureFlags } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let parent: Agent;
let parentEmail: string;
let seasonId: string;
let tenU: string;
let eightU: string;
let paidRegId: string;
let newPlayerId: string;
let previousCurrent: string | null = null;

async function person(prefix: string) {
  const a = agent();
  const email = uniqueEmail(prefix);
  await signUp(a, email, `${prefix} Person`);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  return { a, email, userId: u!.id };
}

const drain = async () => {
  for (;;) {
    const r = await processOutbox(100);
    if (r.processed + r.failed === 0) return;
  }
};

beforeAll(async () => {
  for (const key of ["r1b.registration"]) {
    await db.insert(featureFlags).values({ key, enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  }
  resetFlagCache();
  clearSubscribers();
  registerSubscribers();
  const a = await person("forms-admin");
  admin = a.a;
  adminId = a.userId;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });

  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  if (previousCurrent) await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, previousCurrent));
  const [s] = await db
    .insert(seasons)
    .values({ name: "Forms Season", year: 2027, status: "registration_open", isCurrent: "current", registrationOpensAt: new Date(Date.now() - 86400_000) })
    .returning();
  seasonId = s!.id;
  const [d1] = await db.insert(divisions).values({ seasonId, name: "Forms 10U", capacity: 20, priceCents: 10000, status: "open" }).returning();
  const [d2] = await db.insert(divisions).values({ seasonId, name: "Forms 8U", capacity: 20, priceCents: 10000, status: "open" }).returning();
  tenU = d1!.id;
  eightU = d2!.id;

  // A family with one child already registered (paid) in 10U, and one not yet registered.
  const p = await person("forms-parent");
  parent = p.a;
  parentEmail = p.email;
  const [h] = await db.insert(households).values({ displayName: "Forms Family" }).returning();
  await db.insert(householdMembers).values({ householdId: h!.id, userId: p.userId });
  const [kid] = await db.insert(players).values({ householdId: h!.id, firstName: "Jordan", lastName: "Forms", birthDate: "2016-05-05", gender: "boy" }).returning();
  const [reg] = await db
    .insert(registrations)
    .values({ seasonId, divisionId: tenU, playerId: kid!.id, householdId: h!.id, status: "paid", priceCents: 10000, totalCents: 10000, submittedBy: p.userId })
    .returning();
  paidRegId = reg!.id;
  const [kid2] = await db.insert(players).values({ householdId: h!.id, firstName: "Riley", lastName: "Forms", birthDate: "2016-06-06", gender: "boy" }).returning();
  newPlayerId = kid2!.id;
});

afterAll(async () => {
  await drain();
  clearSubscribers();
  // Don't leave test forms asking other test files' registrations for anything.
  await db.update(forms).set({ status: "archived" }).where(eq(forms.createdBy, adminId));
  await db.update(seasons).set({ isCurrent: null }).where(eq(seasons.id, seasonId));
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
});

describe("pages admins add", () => {
  it("adds a draft page, publishes it to the menu, and keeps the menu from overflowing", async () => {
    const draft = await admin.post("/api/v1/admin/content/pages").send({ slug: "field-locations", title: "Field locations", body: "## Where we play", nav: "menu", navLabel: "Fields" });
    expect(draft.status).toBe(201);
    expect(draft.body.page.published).toBe(false);
    expect((await agent().get("/api/v1/pages/field-locations")).status).toBe(404);

    const live = await admin.put("/api/v1/admin/content/pages/field-locations").send({ title: "Field locations", body: "## Where we play", nav: "menu", navLabel: "Fields", published: true });
    expect(live.status).toBe(200);
    expect((await agent().get("/api/v1/pages/field-locations")).body.page.title).toBe("Field locations");
    const site = await agent().get("/api/v1/site");
    expect(site.body.links.menu).toContainEqual({ href: "/p/field-locations", label: "Fields" });

    for (const slug of ["menu-two", "menu-three"]) {
      expect((await admin.post("/api/v1/admin/content/pages").send({ slug, title: slug, body: "", nav: "menu", published: true })).status).toBe(201);
    }
    const full = await admin.post("/api/v1/admin/content/pages").send({ slug: "menu-four", title: "Four", body: "", nav: "menu" });
    expect(full.status).toBe(409);
    expect((await admin.post("/api/v1/admin/content/pages").send({ slug: "menu-four", title: "Four", body: "", nav: "footer", published: true })).status).toBe(201);
    expect((await agent().get("/api/v1/site")).body.links.footer).toContainEqual({ href: "/p/menu-four", label: "Four" });
  });

  it("refuses taken or built-in addresses, and only deletes added pages", async () => {
    expect((await admin.post("/api/v1/admin/content/pages").send({ slug: "about", title: "x", body: "" })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/content/pages").send({ slug: "Bad Slug!", title: "x", body: "" })).status).toBe(400);
    expect((await admin.post("/api/v1/admin/content/pages").send({ slug: "field-locations", title: "x", body: "" })).status).toBe(409);
    expect((await admin.delete("/api/v1/admin/content/pages/about")).status).toBe(409);
    for (const slug of ["menu-two", "menu-three", "menu-four"]) expect((await admin.delete(`/api/v1/admin/content/pages/${slug}`)).status).toBe(200);
    expect((await agent().get("/api/v1/pages/menu-two")).status).toBe(404);
    // Families can't add pages.
    expect((await parent.post("/api/v1/admin/content/pages").send({ slug: "nope", title: "x", body: "" })).status).toBe(403);
  });
});

describe("waivers & forms", () => {
  it("moved the original waivers into the library as live forms", async () => {
    const res = await admin.get("/api/v1/admin/forms");
    expect(res.status).toBe(200);
    const titles = res.body.items.filter((f: { status: string }) => f.status === "live").map((f: { title: string }) => f.title);
    expect(titles.length).toBeGreaterThanOrEqual(4);
    const opts = await parent.get("/api/v1/registration/options");
    expect(opts.body.waivers.length).toBeGreaterThanOrEqual(3);
  });

  let travelId: string;
  it("adds a 10U form with questions; new registrations must complete it", async () => {
    const made = await admin.post("/api/v1/admin/forms").send({
      title: "Tournament travel consent",
      audience: "player",
      divisionIds: [tenU],
      required: true,
      askExisting: true,
      dueDate: "2027-03-01",
      body: "I give permission for travel.",
      questions: [
        { label: "Will your child ride with the team?", type: "yesno", required: true },
        { label: "Emergency phone during the trip", type: "phone", required: true },
        { label: "Shirt size", type: "choice", required: false, options: ["Youth M", "Youth L"] },
      ],
      status: "live",
    });
    expect(made.status).toBe(201);
    travelId = made.body.id;

    const opts = await parent.get("/api/v1/registration/options");
    const travel = opts.body.waivers.find((w: { id: string }) => w.id === travelId);
    expect(travel.divisionIds).toEqual([tenU]);
    const qs = travel.questions as { id: string; type: string }[];
    const legacy = opts.body.waivers.filter((w: { id: string; required: boolean }) => w.id !== travelId && w.required).map((w: { id: string }) => ({ formId: w.id, agreed: true }));

    const base = { playerId: newPlayerId, divisionId: tenU, signerName: "Pat Forms" };
    const missing = await parent.post("/api/v1/registrations").send({ ...base, forms: legacy });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain("Tournament travel consent");
    const badPhone = await parent.post("/api/v1/registrations").send({ ...base, forms: [...legacy, { formId: travelId, agreed: true, answers: { [qs[0]!.id]: "yes", [qs[1]!.id]: "call me" } }] });
    expect(badPhone.status).toBe(400);
    const ok = await parent.post("/api/v1/registrations").send({ ...base, forms: [...legacy, { formId: travelId, agreed: true, answers: { [qs[0]!.id]: "yes", [qs[1]!.id]: "(904) 555-0100" } }] });
    expect(ok.status).toBe(201);
    const [r] = await db.select().from(formResponses).where(and(eq(formResponses.formId, travelId), eq(formResponses.subjectId, ok.body.registration.id)));
    expect(r).toMatchObject({ agreed: true, signerName: "Pat Forms", version: 1 });
    expect(r!.answers[qs[1]!.id]).toBe("(904) 555-0100");

    // 8U families aren't asked for it.
    const eight = await parent.post("/api/v1/registrations").send({ ...base, divisionId: eightU, forms: legacy });
    expect([201, 409]).toContain(eight.status); // 409 only if the child doesn't fit 8U's ages
    if (eight.status === 400) throw new Error(eight.body.error.message);
  });

  it("asks families who already registered on My account, and emails them", async () => {
    await drain();
    expect(mail.last(parentEmail, "form.reminder")?.text).toContain("Tournament travel consent");
    const mine = await parent.get("/api/v1/me/forms");
    const item = mine.body.outstanding.find((o: { form: { id: string } }) => o.form.id === travelId);
    expect(item).toMatchObject({ subjectType: "registration", subjectId: paidRegId, label: "Jordan · Forms 10U" });

    const qs = item.form.questions as { id: string }[];
    // Someone else's registration: refused.
    const other = await person("forms-other");
    expect((await other.a.post("/api/v1/me/forms").send({ formId: travelId, subjectType: "registration", subjectId: paidRegId, signerName: "Not Me", agreed: true, answers: {} })).status).toBe(404);

    const done = await parent
      .post("/api/v1/me/forms")
      .send({ formId: travelId, subjectType: "registration", subjectId: paidRegId, signerName: "Pat Forms", agreed: true, answers: { [qs[0]!.id]: "no", [qs[1]!.id]: "904-555-0101" } });
    expect(done.status).toBe(201);
    expect((await parent.get("/api/v1/me/forms")).body.outstanding.find((o: { form: { id: string } }) => o.form.id === travelId)).toBeUndefined();
    expect((await parent.get("/api/v1/me/forms")).body.completed.some((c: { title: string }) => c.title === "Tournament travel consent")).toBe(true);
  });

  it("tracks who has completed it, reminds at most once a day, and exports a spreadsheet", async () => {
    const t = await admin.get(`/api/v1/admin/forms/${travelId}/tracking`);
    expect(t.status).toBe(200);
    const row = t.body.rows.find((r: { subjectId: string }) => r.subjectId === paidRegId);
    expect(row).toMatchObject({ done: true, name: "Jordan Forms" });
    expect(row.userIds).toBeUndefined();
    // Reminders went out when it was published.
    expect((await admin.post(`/api/v1/admin/forms/${travelId}/remind`)).status).toBe(409);

    const csv = await admin.get(`/api/v1/admin/forms/${travelId}/export.csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("Will your child ride with the team?");
    expect(csv.text).toContain('"Jordan Forms"');
    // Phone numbers starting with "+" or "-" can't become spreadsheet formulas.
    expect(csv.text).not.toMatch(/,"[=+@]/);
  });

  it("changing the wording makes a new version; 'sign again' asks everyone again", async () => {
    const cur = (await admin.get(`/api/v1/admin/forms/${travelId}`)).body.form;
    const body = {
      title: cur.title,
      audience: "player",
      divisionIds: [tenU],
      required: true,
      askExisting: true,
      dueDate: "2027-03-01",
      questions: cur.questions,
      status: "live",
    };
    // Settings only: same version, nobody asked again.
    const same = await admin.put(`/api/v1/admin/forms/${travelId}`).send({ ...body, body: cur.body });
    expect(same.body).toMatchObject({ version: 1, newVersion: false });
    // New wording without "sign again": version 2, earlier signatures still count.
    const v2 = await admin.put(`/api/v1/admin/forms/${travelId}`).send({ ...body, body: `${cur.body} Updated.`, resign: false });
    expect(v2.body).toMatchObject({ version: 2, newVersion: true });
    expect((await parent.get("/api/v1/me/forms")).body.outstanding.some((o: { form: { id: string } }) => o.form.id === travelId)).toBe(false);
    // Version 3 with "sign again": the family is asked again.
    const v3 = await admin.put(`/api/v1/admin/forms/${travelId}`).send({ ...body, body: `${cur.body} Updated again.`, resign: true });
    expect(v3.body).toMatchObject({ version: 3, newVersion: true });
    expect((await parent.get("/api/v1/me/forms")).body.outstanding.some((o: { form: { id: string } }) => o.form.id === travelId)).toBe(true);
    // Archiving stops asking, and keeps every signature.
    expect((await admin.post(`/api/v1/admin/forms/${travelId}/archive`).send({ archived: true })).status).toBe(200);
    expect((await parent.get("/api/v1/me/forms")).body.outstanding.some((o: { form: { id: string } }) => o.form.id === travelId)).toBe(false);
    expect((await db.select().from(formResponses).where(eq(formResponses.formId, travelId))).length).toBeGreaterThanOrEqual(2);
  });

  it("validates forms and is admins only", async () => {
    expect((await parent.get("/api/v1/admin/forms")).status).toBe(403);
    const bad = await admin.post("/api/v1/admin/forms").send({ title: "X form", audience: "player", body: "", questions: [{ label: "Pick", type: "choice", required: true, options: ["One"] }] });
    expect(bad.status).toBe(400);
    const staffDivs = await admin.post("/api/v1/admin/forms").send({ title: "Coach form", audience: "staff", divisionIds: [tenU], body: "" });
    expect(staffDivs.status).toBe(400);
  });
});
