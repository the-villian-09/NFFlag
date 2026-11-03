import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../src/config.js";
import { db } from "../src/db/client.js";
import { smsSubscriptions, user } from "../src/db/schema/index.js";
import { agent, signUp, uniqueEmail } from "./helpers.js";

const SECRET = "s".repeat(40);

describe("website-only API", () => {
  afterEach(() => {
    env.API_PROXY_SECRET = undefined;
  });

  it("refuses direct calls once the secret is set, but keeps health checks and webhooks open", async () => {
    env.API_PROXY_SECRET = SECRET;
    expect((await agent().get("/api/v1/site")).status).toBe(404);
    expect((await agent().get("/api/v1/site").set("x-nffl-proxy", "wrong".repeat(8))).status).toBe(404);
    expect((await agent().get("/api/v1/site").set("x-nffl-proxy", SECRET)).status).toBe(200);
    expect((await agent().get("/api/v1/health")).status).toBe(200);
    // A webhook without a valid signature is still refused by the webhook itself, not by the guard.
    expect((await agent().post("/api/v1/webhooks/stripe").send("{}")).status).not.toBe(404);
  });

  it("uses only the visitor IP the website passes on", async () => {
    const a = agent();
    const email = uniqueEmail("ip");
    await signUp(a, email);
    env.API_PROXY_SECRET = SECRET;
    const res = await a
      .put("/api/v1/me/sms")
      .set("x-nffl-proxy", SECRET)
      .set("x-nffl-client-ip", "203.0.113.7")
      .set("x-forwarded-for", "1.2.3.4")
      .send({ phone: "9045550142", subscribe: true });
    expect(res.status).toBe(200);
    const [u] = await db.select().from(user).where(eq(user.email, email));
    const [row] = await db.select().from(smsSubscriptions).where(eq(smsSubscriptions.userId, u!.id));
    expect(row!.consentIp).toBe("203.0.113.7");
  });
});
