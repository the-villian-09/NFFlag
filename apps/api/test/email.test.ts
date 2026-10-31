import { describe, expect, it } from "vitest";
import { templates } from "../src/lib/email-templates.js";
import { agent, mail, uniqueEmail } from "./helpers.js";

describe("emails", () => {
  it("sign-up confirmation has a button to the link, plus a plain-text version", async () => {
    const email = uniqueEmail("buttons");
    await agent().post("/api/auth/sign-up/email").send({ email, password: "correct-horse-battery", name: "Pat" });
    const msg = mail.last(email, "auth.verify_email")!;
    const url = msg.text.match(/https?:\/\/\S+/)![0];
    expect(msg.html).toContain(">\n        Confirm my email\n      </a>");
    expect(msg.html).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
    expect(msg.text).toContain("Confirm my email: http");
  });

  it("escapes anything typed by families", () => {
    const m = templates.contactMessage("league@example.com", {
      name: `<script>alert(1)</script>`,
      email: "a@example.com",
      phone: null,
      topic: "general",
      message: `<img src=x onerror=alert(1)>`,
      adminUrl: "https://nfflag.com/admin/content",
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.replyTo).toBe("a@example.com");
  });

  it("every template renders a heading and keeps its links in the text version", () => {
    const all = [
      templates.resetPassword("a@x.com", "https://nfflag.com/reset?t=1"),
      templates.loginCode("a@x.com", "123456"),
      templates.registrationPaid("a@x.com", { player: "Sam", division: "Boys 8U", season: "2027", total: "$100.00", receiptUrl: "https://squareup.com/r", dashboardUrl: "https://nfflag.com/dashboard" }),
      templates.registrationDecision("a@x.com", { player: "Sam", division: "Boys 8U", approved: true, reason: null, dashboardUrl: "https://nfflag.com/dashboard" }),
      templates.registrationRefunded("a@x.com", { player: "Sam", amount: "$100.00", dashboardUrl: "https://nfflag.com/dashboard" }),
      templates.squareDisconnected("a@x.com", { by: "Avery", merchantName: "NFFL", reason: null, adminUrl: "https://nfflag.com/admin/payments" }),
    ];
    for (const m of all) {
      expect(m.html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
      for (const link of m.text.match(/https:\/\/\S+/g) ?? []) expect(m.html).toContain(`href="${link}"`);
    }
    expect(all[1]!.html).toContain("123456");
  });
});
