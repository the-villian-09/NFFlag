import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { auditLogs, smsSubscriptions, user } from "../src/db/schema/index.js";
import { agent, signUp, uniqueEmail } from "./helpers.js";

describe("text alert opt-in", () => {
  it("records consent, changes numbers and opts out", async () => {
    const a = agent();
    const email = uniqueEmail("sms");
    await signUp(a, email);
    const [u] = await db.select().from(user).where(eq(user.email, email));

    expect((await agent().get("/api/v1/me/sms")).status).toBe(401);
    const start = await a.get("/api/v1/me/sms");
    expect(start.body).toMatchObject({ phone: null, subscribed: false });
    expect(start.body.consentText).toContain("Reply HELP");

    expect((await a.put("/api/v1/me/sms").send({ phone: "555-1234", subscribe: true })).status).toBe(400);
    expect((await a.put("/api/v1/me/sms").send({ phone: "", subscribe: true })).status).toBe(400);

    const on = await a.put("/api/v1/me/sms").send({ phone: "(904) 555-0142", subscribe: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ phone: "+19045550142", subscribed: true });
    const [row] = await db.select().from(smsSubscriptions).where(eq(smsSubscriptions.userId, u!.id));
    expect(row!.consentVersion).toBeTruthy();
    expect(row!.consentAt).toBeTruthy();

    // A new number is a new consent.
    const moved = await a.put("/api/v1/me/sms").send({ phone: "1-904-555-0199", subscribe: true });
    expect(moved.body.phone).toBe("+19045550199");
    const [row2] = await db.select().from(smsSubscriptions).where(eq(smsSubscriptions.userId, u!.id));
    expect(row2!.consentAt!.getTime()).toBeGreaterThanOrEqual(row!.consentAt!.getTime());

    const off = await a.put("/api/v1/me/sms").send({ phone: "9045550199", subscribe: false });
    expect(off.body).toMatchObject({ subscribed: false, stoppedVia: "account", phone: "+19045550199" });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, u!.id));
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(["sms.subscribe", "sms.unsubscribe"]));
  });

  it("publishes the Text alerts page and texting terms", async () => {
    const page = await agent().get("/api/v1/pages/text-alerts");
    expect(page.status).toBe(200);
    expect(page.body.page.body).toContain("STOP");
    expect((await agent().get("/api/v1/pages/privacy")).body.page.body).toContain("No mobile information will be shared");
    expect((await agent().get("/api/v1/pages/terms")).body.page.body).toContain("Reply **HELP**");
  });
});
