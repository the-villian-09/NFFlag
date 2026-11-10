/**
 * The invisible "are you human" check, with TURNSTILE_SECRET_KEY set and
 * Cloudflare's answer faked: token "good" passes on our hostname, "elsewhere"
 * passes on another site's hostname, anything else fails.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TURNSTILE_SECRET_KEY = "turnstile-test-secret";
});

import { SITEVERIFY_URL } from "../src/lib/turnstile.js";
import { agent, mail, uniqueEmail } from "./helpers.js";

const realFetch = globalThis.fetch;
const seen: { secret: string; response: string; remoteip?: string }[] = [];

beforeAll(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== SITEVERIFY_URL) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    seen.push(body);
    const ok = body.secret === "turnstile-test-secret" && (body.response === "good" || body.response === "elsewhere");
    const hostname = body.response === "elsewhere" ? "copycat.example" : "localhost";
    return new Response(JSON.stringify(ok ? { success: true, hostname } : { success: false, "error-codes": ["invalid-input-response"] }), {
      headers: { "content-type": "application/json" },
    });
  });
});
afterAll(() => vi.unstubAllGlobals());

const signUpBody = () => ({ email: uniqueEmail("human"), password: "correct-horse-battery", name: "Pat" });

describe("Turnstile on sign-up, reset and resend", () => {
  it("sign-up needs a passing check", async () => {
    expect((await agent().post("/api/auth/sign-up/email").send(signUpBody())).status).toBe(400);
    expect((await agent().post("/api/auth/sign-up/email").set("x-captcha-response", "bot").send(signUpBody())).status).toBe(403);
    // Solved on someone else's site.
    expect((await agent().post("/api/auth/sign-up/email").set("x-captcha-response", "elsewhere").send(signUpBody())).status).toBe(403);
    const body = signUpBody();
    const ok = await agent().post("/api/auth/sign-up/email").set("x-captcha-response", "good").send(body);
    expect(ok.status).toBe(200);
    expect(mail.last(body.email, "auth.verify_email")).toBeDefined();
  });

  it("password reset and resend-confirmation need a passing check", async () => {
    const email = uniqueEmail("human-reset");
    const res0 = await agent().post("/api/auth/sign-up/email").set("x-captcha-response", "good").send({ email, password: "correct-horse-battery", name: "Pat" });
    expect(res0.status).toBe(200);
    const reset = { email, redirectTo: "http://localhost:3000/reset-password" };
    expect((await agent().post("/api/auth/request-password-reset").send(reset)).status).toBe(400);
    expect((await agent().post("/api/auth/request-password-reset").set("x-captcha-response", "good").send(reset)).status).toBe(200);
    expect((await agent().post("/api/auth/send-verification-email").send({ email })).status).toBe(400);
    expect((await agent().post("/api/auth/send-verification-email").set("x-captcha-response", "good").send({ email })).status).toBe(200);
  });

  it("sends the secret and the visitor's IP to Cloudflare", async () => {
    const last = seen.at(-1)!;
    expect(last.secret).toBe("turnstile-test-secret");
    expect(last.remoteip).toBeTruthy();
  });

  it("sign-in doesn't need it (rate limits cover it)", async () => {
    const res = await agent().post("/api/auth/sign-in/email").send({ email: uniqueEmail("nobody"), password: "wrong-password-123" });
    expect(res.status).toBe(401);
  });

  it("the contact form needs a passing check", async () => {
    const msg = { name: "Pat", email: uniqueEmail("human-contact"), message: "When does practice start?" };
    const missing = await agent().post("/api/v1/contact").send(msg);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("MISSING_RESPONSE");
    expect((await agent().post("/api/v1/contact").set("x-captcha-response", "bot").send(msg)).status).toBe(403);
    expect((await agent().post("/api/v1/contact").set("x-captcha-response", "good").send(msg)).status).toBe(202);
  });

  it("refuses when Cloudflare can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const msg = { name: "Pat", email: uniqueEmail("human-down"), message: "Is anyone there?" };
    const res = await agent().post("/api/v1/contact").set("x-captcha-response", "good").send(msg);
    expect(res.status).toBe(503);
    vi.unstubAllGlobals();
  });
});
