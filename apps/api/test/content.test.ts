import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, contactMessages, user, userRoleAssignments } from "../src/db/schema/index.js";
import { agent, mail, signUp, uniqueEmail, type Agent } from "./helpers.js";

describe("public content", () => {
  it("serves seeded placeholder pages and 404s unknown slugs", async () => {
    for (const slug of ["about", "rules", "coaches", "faq", "contact", "privacy", "terms"]) {
      const res = await agent().get(`/api/v1/pages/${slug}`);
      expect(res.status).toBe(200);
      expect(res.body.page.title.length).toBeGreaterThan(0);
    }
    const about = await agent().get("/api/v1/pages/about");
    expect(about.body.page.isPlaceholder).toBe(true);
    expect(about.body.page.body).toContain("December 1");
    expect((await agent().get("/api/v1/pages/secret")).status).toBe(404);
  });

  it("returns the announcement banner and public contact details", async () => {
    const res = await agent().get("/api/v1/site");
    expect(res.status).toBe(200);
    expect(res.body.announcement.message).toContain("December 1");
    expect(res.body.contact).toEqual({ publicEmail: null, phone: null });
  });
});

describe("contact form", () => {
  it("stores the message and validates input", async () => {
    const bad = await agent().post("/api/v1/contact").send({ name: "", email: "nope", message: "hi" });
    expect(bad.status).toBe(400);

    const ok = await agent()
      .post("/api/v1/contact")
      .send({ name: "Pat Parent", email: "pat@example.com", topic: "registration", message: "When do tryouts start?" });
    expect(ok.status).toBe(202);
    const rows = await db.select().from(contactMessages).where(eq(contactMessages.email, "pat@example.com"));
    expect(rows).toHaveLength(1);
    // No inbox email configured yet: stored, not emailed.
    expect(rows[0]!.emailedAt).toBeNull();
  });

  it("silently drops honeypot submissions", async () => {
    const res = await agent()
      .post("/api/v1/contact")
      .send({ name: "Bot", email: "bot@example.com", message: "Buy things now", website: "http://spam.example" });
    expect(res.status).toBe(202);
    const rows = await db.select().from(contactMessages).where(eq(contactMessages.email, "bot@example.com"));
    expect(rows).toHaveLength(0);
  });
});

describe("admin content editing", () => {
  let admin: Agent;
  let adminId: string;

  beforeAll(async () => {
    const email = uniqueEmail("content-admin");
    admin = agent();
    await signUp(admin, email);
    const [u] = await db.select().from(user).where(eq(user.email, email));
    adminId = u!.id;
    await db.insert(userRoleAssignments).values({ userId: adminId, roleKey: "league_admin" });
  });

  it("forbids parents", async () => {
    const p = agent();
    await signUp(p, uniqueEmail("not-admin"));
    expect((await p.get("/api/v1/admin/content/pages")).status).toBe(403);
    expect((await p.put("/api/v1/admin/content/pages/about").send({ title: "x", body: "y" })).status).toBe(403);
  });

  it("does not block other admin screens for admins without content permission", async () => {
    const res = await admin.get("/api/v1/admin/audit");
    expect(res.status).toBe(200);
  });

  it("edits a page, clears the placeholder flag and audits the change", async () => {
    const list = await admin.get("/api/v1/admin/content/pages");
    expect(list.status).toBe(200);
    expect(list.body.items.map((p: { slug: string }) => p.slug)).toEqual([
      "about",
      "rules",
      "coaches",
      "faq",
      "contact",
      "privacy",
      "terms",
      "waiver-liability",
      "waiver-medical",
      "waiver-media",
    ]);

    const res = await admin.put("/api/v1/admin/content/pages/faq").send({ title: "FAQ", body: "## Updated\n\nNew answer." });
    expect(res.status).toBe(200);
    const pub = await agent().get("/api/v1/pages/faq");
    expect(pub.body.page).toMatchObject({ title: "FAQ", body: "## Updated\n\nNew answer.", isPlaceholder: false });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.targetId, "faq"));
    expect(audit[0]).toMatchObject({ actorUserId: adminId, action: "content.page.update" });
  });

  it("updates the banner, rejects unsafe links, and can turn it off", async () => {
    const unsafe = await admin
      .put("/api/v1/admin/content/settings/announcement")
      .send({ enabled: true, message: "Hi", linkText: "Click", linkHref: "javascript:alert(1)" });
    expect(unsafe.status).toBe(400);

    await admin.put("/api/v1/admin/content/settings/announcement").send({ enabled: true, message: "Rainout tonight", linkHref: "/faq", linkText: "Details" });
    expect((await agent().get("/api/v1/site")).body.announcement).toMatchObject({ message: "Rainout tonight", linkHref: "/faq" });

    await admin.put("/api/v1/admin/content/settings/announcement").send({ enabled: false, message: "Rainout tonight" });
    expect((await agent().get("/api/v1/site")).body.announcement).toBeNull();
  });

  it("emails contact messages to the inbox once it's set, with reply-to the sender", async () => {
    await admin
      .put("/api/v1/admin/content/settings/contact")
      .send({ inboxEmail: "league@example.com", publicEmail: "info@example.com", phone: "904-555-0100" });
    expect((await agent().get("/api/v1/site")).body.contact).toEqual({ publicEmail: "info@example.com", phone: "904-555-0100" });

    await agent().post("/api/v1/contact").send({ name: "Sam", email: "sam@example.com", message: "Can I coach 8U?", topic: "volunteering" });
    const sent = mail.last("league@example.com", "contact.message");
    expect(sent).toMatchObject({ replyTo: "sam@example.com" });
    expect(sent!.text).toContain("Can I coach 8U?");

    const msgs = await admin.get("/api/v1/admin/content/contact-messages");
    expect(msgs.body.items[0]).toMatchObject({ email: "sam@example.com", topic: "volunteering" });
    expect(msgs.body.items[0].emailedAt).not.toBeNull();
    expect(msgs.body.items[0].ipAddress).toBeUndefined();
  });
});
