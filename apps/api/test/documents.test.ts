/** Required uploads: children's birth certificate, insurance card and headshot; staff and referee headshots. */
import { and, eq, like } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { db } from "../src/db/client.js";
import { auditLogs, documents, featureFlags, rosterEntries, seasons, teams, user, userRoleAssignments } from "../src/db/schema/index.js";
import { resetFlagCache } from "../src/modules/platform/flags.js";
import { agent, signUp, uniqueEmail, type Agent } from "./helpers.js";

let admin: Agent;
let adminId: string;
let seasonId: string;
let divisionId: string;
let previousCurrent: string | null = null;
const accept = { signerName: "Pat Parent", acceptedWaivers: ["waiver-liability", "waiver-medical", "waiver-media"] };

/** A phone-style JPEG with hidden data (camera, GPS) in it. */
async function phonePhoto() {
  return sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .withExif({ IFD0: { Make: "PhoneCo", Model: "Phone 15" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "30/1 19/1 0/1" } })
    .jpeg()
    .toBuffer();
}
const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

async function family(name: string) {
  const a = agent();
  const email = uniqueEmail(name.toLowerCase());
  await signUp(a, email, `${name} Parent`);
  await a.post("/api/v1/households").send({ displayName: `The ${name} Family`, phone: "904-555-0100" });
  const p = await a.post("/api/v1/players").send({
    firstName: name,
    lastName: "Kid",
    birthDate: "2016-06-01",
    gender: "boy",
    medical: { emergencyContactName: "Grandma", emergencyContactPhone: "904-555-0199" },
  });
  return { a, email, playerId: p.body.player.id as string };
}
const put = (a: Agent, path: string, buf: Buffer, type: string) => a.put(`/api/v1${path}`).set("content-type", type).send(buf);

beforeAll(async () => {
  admin = agent();
  const email = uniqueEmail("docs-admin");
  await signUp(admin, email, "Docs Admin");
  const [u] = await db.select().from(user).where(eq(user.email, email));
  adminId = u!.id;
  await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "super_admin" });
  const [cur] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current"));
  previousCurrent = cur?.id ?? null;
  const s = await admin.post("/api/v1/admin/league/seasons").send({
    name: "Docs Season",
    year: 2027,
    status: "registration_open",
    registrationOpensAt: new Date(Date.now() - 86400_000).toISOString(),
    registrationClosesAt: "",
    ageCutoffDate: "",
    isCurrent: true,
  });
  seasonId = s.body.season.id;
  // Free division, so paying needs no card.
  const d = await admin.post(`/api/v1/admin/league/seasons/${seasonId}/divisions`).send({ name: "Docs 10U", genderPolicy: "coed", capacity: 50, priceCents: 0, status: "open" });
  divisionId = d.body.division.id;
  for (const k of ["r1b.registration", "r6.documents", "r5.referees", "r2.staff_applications"]) await admin.put(`/api/v1/admin/flags/${k}`).send({ enabled: true });
  resetFlagCache();
});

afterAll(async () => {
  await db.update(seasons).set({ isCurrent: null });
  if (previousCurrent) await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, previousCurrent));
  else await db.update(seasons).set({ isCurrent: "current" }).where(like(seasons.name, "%(sample)"));
  for (const k of ["r1b.registration", "r6.documents", "r5.referees", "r2.staff_applications"]) await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, k));
  await db.update(userRoleAssignments).set({ revokedAt: new Date() }).where(eq(userRoleAssignments.userId, adminId));
  resetFlagCache();
});

describe("children's documents", () => {
  it("can't pay until the birth certificate, insurance card and headshot are uploaded", async () => {
    const f = await family("Docsy");
    const r = await f.a.post("/api/v1/registrations").send({ playerId: f.playerId, divisionId, ...accept });
    expect(r.status).toBe(201);
    const blocked = await f.a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ expectedTotalCents: 0 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.missingDocuments).toEqual(["birth_certificate", "insurance_card", "player_photo"]);
    expect(blocked.body.error.message).toBe("Upload the birth certificate, medical insurance card and headshot before paying.");

    expect((await put(f.a, `/players/${f.playerId}/documents/birth_certificate`, pdf, "application/pdf")).status).toBe(200);
    expect((await put(f.a, `/players/${f.playerId}/documents/insurance_card`, await phonePhoto(), "image/jpeg")).status).toBe(200);
    const head = await put(f.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg");
    expect(head.body.document.url).toMatch(/^\/api\/v1\/documents\/.+\/file$/);
    const list = await f.a.get(`/api/v1/players/${f.playerId}/documents`);
    expect(list.body.items.every((i: { document: unknown }) => i.document)).toBe(true);

    const paid = await f.a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ expectedTotalCents: 0 });
    expect(paid.status).toBe(200);
    expect(paid.body.registration.status).toBe("paid");
  });

  it("photos are shrunk and stripped of hidden data; other files are refused", async () => {
    const f = await family("Clean");
    const res = await put(f.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg");
    const file = await f.a.get(res.body.document.url).buffer(true);
    expect(file.headers["content-type"]).toBe("image/jpeg");
    expect(file.headers["cache-control"]).toBe("private, no-store");
    const meta = await sharp(file.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width!, meta.height!)).toBe(1200);

    const text = await put(f.a, `/players/${f.playerId}/documents/insurance_card`, Buffer.from("not really a picture at all"), "image/jpeg");
    expect(text.status).toBe(400);
    expect((await put(f.a, `/players/${f.playerId}/documents/player_photo`, pdf, "application/pdf")).body.error.message).toMatch(/needs to be a photo/);
    expect((await put(f.a, `/players/${f.playerId}/documents/passport`, pdf, "application/pdf")).status).toBe(400);
  });

  it("replacing a file retires the old one; the birth certificate carries to the next season, the rest don't", async () => {
    const f = await family("Replace");
    const first = await put(f.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg");
    const second = await put(f.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg");
    expect(second.body.document.id).not.toBe(first.body.document.id);
    expect((await f.a.get(first.body.document.url)).status).toBe(404);
    const [old] = await db.select().from(documents).where(eq(documents.id, first.body.document.id));
    expect(old!.replacedAt).not.toBeNull();
    expect(existsSync(join(resolve(env.UPLOADS_DIR), old!.storageKey))).toBe(false);

    await put(f.a, `/players/${f.playerId}/documents/birth_certificate`, pdf, "application/pdf");
    await put(f.a, `/players/${f.playerId}/documents/insurance_card`, pdf, "application/pdf");
    // A new season starts.
    const [next] = await db.insert(seasons).values({ name: "Docs Next", year: 2028, status: "draft" }).returning();
    await db.update(seasons).set({ isCurrent: null });
    await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, next!.id));
    const list = (await f.a.get(`/api/v1/players/${f.playerId}/documents`)).body.items;
    expect(list.find((i: { kind: string }) => i.kind === "birth_certificate").document).not.toBeNull();
    expect(list.find((i: { kind: string }) => i.kind === "insurance_card").document).toBeNull();
    expect(list.find((i: { kind: string }) => i.kind === "player_photo").document).toBeNull();
    await db.update(seasons).set({ isCurrent: null });
    await db.update(seasons).set({ isCurrent: "current" }).where(eq(seasons.id, seasonId));
  });

  it("only the family, admins (logged for sensitive files) and the child's coaches (headshot only) can see them", async () => {
    const f = await family("Private");
    const bc = (await put(f.a, `/players/${f.playerId}/documents/birth_certificate`, pdf, "application/pdf")).body.document;
    const head = (await put(f.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg")).body.document;
    const other = await family("Snoopy");
    expect((await other.a.get(bc.url)).status).toBe(404);
    expect((await put(other.a, `/players/${f.playerId}/documents/player_photo`, await phonePhoto(), "image/jpeg")).status).toBe(404);
    expect((await other.a.get(`/api/v1/players/${f.playerId}/documents`)).status).toBe(404);

    const seen = await admin.get(bc.url);
    expect(seen.status).toBe(200);
    expect(seen.headers["content-type"]).toBe("application/pdf");
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "document.view"), eq(auditLogs.targetId, bc.id)));
    expect(log?.actorUserId).toBe(adminId);

    // A coach of the child's team sees the headshot (and it's on the roster), not the birth certificate.
    const coach = agent();
    const ce = uniqueEmail("doc-coach");
    await signUp(coach, ce, "Doc Coach");
    const [cu] = await db.select().from(user).where(eq(user.email, ce));
    const [team] = await db.insert(teams).values({ seasonId, divisionId, name: "Doc Sharks" }).returning();
    const reg = await f.a.post("/api/v1/registrations").send({ playerId: f.playerId, divisionId, ...accept });
    await db.insert(rosterEntries).values({ teamId: team!.id, divisionId, registrationId: reg.body.registration.id, playerId: f.playerId, source: "draft" });
    await db.insert(userRoleAssignments).values({ userId: cu!.id, roleKey: "head_coach", scopeType: "team", scopeId: team!.id });
    expect((await coach.get(head.url)).status).toBe(200);
    expect((await coach.get(bc.url)).status).toBe(404);
    const roster = await admin.get(`/api/v1/my-teams/${team!.id}`);
    expect(roster.status).toBe(200);
    expect(roster.body.roster[0].photoUrl).toBe(head.url);

    const detail = await admin.get(`/api/v1/admin/league/registrations/${reg.body.registration.id}`);
    expect(detail.body.documents.map((d: { kind: string; document: unknown }) => [d.kind, !!d.document])).toEqual([
      ["birth_certificate", true],
      ["insurance_card", false],
      ["player_photo", true],
    ]);
  });
});

describe("headshots for coaches, team moms and referees", () => {
  it("a referee can't sign up without a headshot", async () => {
    const r = agent();
    await signUp(r, uniqueEmail("doc-ref"), "Doc Ref");
    const form = { phone: "904-555-0123", birthDate: "1990-04-02", certification: "NFL FLAG Official" };
    const blocked = await r.post("/api/v1/referees/applications").send(form);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe("Upload your headshot before signing up.");
    expect((await put(r, "/me/photo", await phonePhoto(), "image/jpeg")).status).toBe(200);
    expect((await r.get("/api/v1/me/photo")).body.document).not.toBeNull();
    const ok = await r.post("/api/v1/referees/applications").send(form);
    expect(ok.status).toBe(201);
    const detail = await admin.get(`/api/v1/admin/referees/applications/${ok.body.application.id}`);
    expect(detail.body.application.photo.url).toMatch(/\/file$/);
    expect((await admin.get(detail.body.application.photo.url)).status).toBe(200);
  });

  it("a coach can't pay the badge fee without a headshot", async () => {
    const c = agent();
    await signUp(c, uniqueEmail("doc-coach2"), "Doc Coach Two");
    const app = await c.post("/api/v1/volunteer/applications").send({ roleKey: "head_coach", phone: "904-555-0111", signerName: "Doc Coach Two", acceptAgreement: true });
    expect(app.status).toBe(201);
    const blocked = await c.post(`/api/v1/volunteer/applications/${app.body.application.id}/pay`).send({ sourceId: "cnon:ok" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.missingDocuments).toEqual(["staff_photo"]);
  });

  it("when the switch is off, nothing is required", async () => {
    await admin.put("/api/v1/admin/flags/r6.documents").send({ enabled: false });
    resetFlagCache();
    const f = await family("Optional");
    const r = await f.a.post("/api/v1/registrations").send({ playerId: f.playerId, divisionId, ...accept });
    expect((await f.a.post(`/api/v1/registrations/${r.body.registration.id}/pay`).send({ expectedTotalCents: 0 })).status).toBe(200);
    await admin.put("/api/v1/admin/flags/r6.documents").send({ enabled: true });
    resetFlagCache();
  });
});
