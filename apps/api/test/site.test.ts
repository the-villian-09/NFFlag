import { eq } from "drizzle-orm";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { siteImages, user, userRoleAssignments } from "../src/db/schema/index.js";
import { agent, signUp, uniqueEmail, type Agent } from "./helpers.js";

const png = (w = 40, h = 30) => sharp({ create: { width: w, height: h, channels: 3, background: "#6cf00c" } }).png().toBuffer();
const idOf = (url: string) => url.split("/").pop()!;

let admin: Agent;
let parent: Agent;

beforeAll(async () => {
  const email = uniqueEmail("site-admin");
  admin = agent();
  await signUp(admin, email);
  const [u] = await db.select().from(user).where(eq(user.email, email));
  await db.insert(userRoleAssignments).values({ userId: u!.id, roleKey: "league_admin" });
  parent = agent();
  await signUp(parent, uniqueEmail("site-parent"));
});

describe("home page photos", () => {
  it("only content admins can replace photos", async () => {
    const res = await parent.put("/api/v1/admin/content/images/slots/heroBoy").set("content-type", "image/png").send(await png());
    expect(res.status).toBe(403);
  });

  it("replaces a photo, serves it publicly, and goes back to the built-in one", async () => {
    expect((await agent().get("/api/v1/homepage")).body.images.heroBoy).toBeNull();

    const up = await admin.put("/api/v1/admin/content/images/slots/heroBoy").set("content-type", "image/png").send(await png(3000, 2000));
    expect(up.status).toBe(200);
    expect(up.body.image.width).toBe(2400); // shrunk to fit
    const first = up.body.image.id as string;
    expect((await agent().get("/api/v1/homepage")).body.images.heroBoy).toBe(first);

    const file = await agent().get(`/api/v1/site-images/${first}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/jpeg");
    expect(file.headers["cache-control"]).toContain("immutable");

    // Replacing removes the old file.
    const again = await admin.put("/api/v1/admin/content/images/slots/heroBoy").set("content-type", "image/png").send(await png());
    expect((await agent().get(`/api/v1/site-images/${first}`)).status).toBe(404);

    const reset = await admin.delete("/api/v1/admin/content/images/slots/heroBoy");
    expect(reset.status).toBe(200);
    expect((await agent().get("/api/v1/homepage")).body.images.heroBoy).toBeNull();
    expect((await agent().get(`/api/v1/site-images/${again.body.image.id}`)).status).toBe(404);
  });

  it("refuses files that aren't photos and unknown slots", async () => {
    const pdf = await admin.put("/api/v1/admin/content/images/slots/heroGirl").set("content-type", "application/octet-stream").send(Buffer.from("%PDF-1.4 hello there"));
    expect(pdf.status).toBe(400);
    expect((await admin.put("/api/v1/admin/content/images/slots/logo").set("content-type", "image/png").send(await png())).status).toBe(404);
    // The slot list can't be set directly.
    expect((await admin.put("/api/v1/admin/content/settings/images").send({ heroBoy: null })).status).toBe(404);
  });
});

describe("in-season home settings", () => {
  it("saves wording and validates links", async () => {
    const current = (await admin.get("/api/v1/admin/content/settings")).body.seasonHome;
    expect(current.mode).toBe("auto");
    expect((await admin.put("/api/v1/admin/content/settings/seasonHome").send({ ...current, ticketsUrl: "http://tixflo.com" })).status).toBe(400);
    const ok = await admin.put("/api/v1/admin/content/settings/seasonHome").send({ ...current, mode: "season", ticketsUrl: "https://tixflo.com/nffl", sponsors: [{ name: "Acme", url: "" }] });
    expect(ok.status).toBe(200);
    const pub = (await agent().get("/api/v1/homepage")).body.seasonHome;
    expect(pub).toMatchObject({ mode: "season", ticketsUrl: "https://tixflo.com/nffl", sponsors: [{ name: "Acme", url: "", logoId: null }] });
    await admin.put("/api/v1/admin/content/settings/seasonHome").send(current);
  });
});

describe("league news", () => {
  it("publishes posts with photos, hides future posts, and cleans up photos", async () => {
    const img = await admin.post("/api/v1/admin/content/images?use=news").set("content-type", "image/png").send(await png());
    expect(img.status).toBe(201);
    const imageId = img.body.image.id as string;

    expect((await parent.post("/api/v1/admin/content/news").send({ title: "Nope" })).status).toBe(403);
    const made = await admin.post("/api/v1/admin/content/news").send({ title: "Picture day Saturday", body: "Bring your smile.", imageId, linkText: "Details", linkUrl: "/schedule" });
    expect(made.status).toBe(201);
    const later = await admin.post("/api/v1/admin/content/news").send({ title: "Playoffs announced", publishedAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(later.status).toBe(201);
    expect((await admin.post("/api/v1/admin/content/news").send({ title: "Bad link", linkUrl: "javascript:alert(1)" })).status).toBe(400);

    const list = await agent().get("/api/v1/news");
    const titles = list.body.items.map((n: { title: string }) => n.title);
    expect(titles).toContain("Picture day Saturday");
    expect(titles).not.toContain("Playoffs announced");
    expect((await agent().get(`/api/v1/news/${later.body.post.id}`)).status).toBe(404);
    const post = list.body.items.find((n: { title: string }) => n.title === "Picture day Saturday");
    expect(idOf(post.imageUrl)).toBe(imageId);

    // Taking the photo off the post deletes it.
    const edited = await admin.put(`/api/v1/admin/content/news/${made.body.post.id}`).send({ title: "Picture day Saturday", body: "Bring your smile.", imageId: null });
    expect(edited.status).toBe(200);
    expect(await db.select().from(siteImages).where(eq(siteImages.id, imageId))).toHaveLength(0);

    expect((await admin.delete(`/api/v1/admin/content/news/${made.body.post.id}`)).status).toBe(200);
    expect((await admin.delete(`/api/v1/admin/content/news/${later.body.post.id}`)).status).toBe(200);
    expect((await agent().get("/api/v1/news")).body.items.map((n: { title: string }) => n.title)).not.toContain("Picture day Saturday");
  });
});
