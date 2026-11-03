import { describe, expect, it } from "vitest";
import { httpLogSerializers, safePath } from "../src/lib/http-log.js";

describe("request log", () => {
  it("keeps only the path and masks tokens", () => {
    expect(safePath("/api/auth/reset-password/abc123?callbackURL=/x")).toBe("/api/auth/reset-password/[redacted]");
    expect(safePath("/api/auth/verify-email?token=SECRET")).toBe("/api/auth/verify-email");
    expect(safePath("/api/v1/square/callback?code=OAUTH&state=s")).toBe("/api/v1/square/callback");
    expect(safePath("/api/v1/admin/search?q=Jane%20Doe")).toBe("/api/v1/admin/search");
  });
  it("never logs headers", () => {
    const req = httpLogSerializers.req({ id: "1", method: "POST", url: "/api/auth/sign-in/email", headers: { cookie: "nffl.session_token=x" } } as never);
    expect(JSON.stringify(req)).not.toContain("session_token");
    const res = httpLogSerializers.res({ statusCode: 200, headers: { "set-cookie": "nffl.session_token=x" } } as never);
    expect(res).toEqual({ statusCode: 200 });
  });
});
