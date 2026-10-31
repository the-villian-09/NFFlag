/**
 * Transactional emails (HTML with buttons + plain-text fallback).
 * Copy is placeholder until the league approves wording.
 */
import type { EmailMessage } from "./email.js";
import { renderEmail, type EmailContent } from "./email-layout.js";

function message(to: string, template: string, subject: string, content: EmailContent, extra: Partial<EmailMessage> = {}): EmailMessage {
  return { to, template, subject, ...renderEmail(content), ...extra };
}

export const templates = {
  verifyEmail(to: string, url: string): EmailMessage {
    return message(to, "auth.verify_email", "Confirm your NFFL account", {
      preheader: "One click to finish creating your account.",
      heading: "Confirm your email",
      paragraphs: ["Welcome to the North Florida Flag League.", "Confirm your email address to finish creating your account."],
      button: { label: "Confirm my email", url },
      footnote: "The link works for 24 hours. If you didn't create an account, you can ignore this email.",
    });
  },

  resetPassword(to: string, url: string): EmailMessage {
    return message(to, "auth.reset_password", "Reset your NFFL password", {
      preheader: "Choose a new password for your NFFL account.",
      heading: "Reset your password",
      paragraphs: ["We received a request to reset your password."],
      button: { label: "Choose a new password", url },
      footnote: "The link expires in 1 hour. If you didn't ask for this, you can ignore this email; your password won't change.",
    });
  },

  loginCode(to: string, code: string): EmailMessage {
    return message(to, "auth.login_code", `Your NFFL sign-in code: ${code}`, {
      preheader: `Your sign-in code is ${code}.`,
      heading: "Your sign-in code",
      paragraphs: ["Enter this code to finish signing in. It expires in 10 minutes."],
      code,
      footnote: "Never share this code. NFFL staff will never ask for it.",
    });
  },

  registrationPaid(
    to: string,
    d: { player: string; division: string; season: string; total: string; receiptUrl: string | null; dashboardUrl: string },
  ): EmailMessage {
    return message(to, "registration.paid", `Registration received: ${d.player}`, {
      preheader: `${d.player} · ${d.division} · ${d.total} paid`,
      heading: "Registration received",
      paragraphs: [
        `Thanks! We received ${d.player}'s registration for ${d.division} (${d.season}).`,
        "What happens next: the league reviews each registration (age and division). We'll email you when it's approved.",
      ],
      details: [
        ["Player", d.player],
        ["Division", d.division],
        ["Amount paid", d.total],
      ],
      button: { label: "View my registrations", url: d.dashboardUrl },
      secondaryButton: d.receiptUrl ? { label: "Card receipt", url: d.receiptUrl } : undefined,
    });
  },

  registrationDecision(
    to: string,
    d: { player: string; division: string; approved: boolean; reason: string | null; dashboardUrl: string },
  ): EmailMessage {
    if (d.approved) {
      return message(to, "registration.approved", `${d.player} is registered for ${d.division}`, {
        preheader: `${d.player}'s registration is approved.`,
        heading: "You're in!",
        paragraphs: [
          `Good news: ${d.player}'s registration for ${d.division} has been approved.`,
          "We'll be in touch with team and schedule details before the season starts.",
        ],
        button: { label: "View my registrations", url: d.dashboardUrl },
      });
    }
    return message(to, "registration.rejected", `Update on ${d.player}'s registration`, {
      preheader: `An update on ${d.player}'s registration.`,
      heading: "Registration not accepted",
      paragraphs: [
        `We weren't able to accept ${d.player}'s registration for ${d.division}.`,
        ...(d.reason ? [`Reason: ${d.reason}`] : []),
        "If a refund applies, it goes back to the card you used (usually 5–10 business days). Reply to this email with any questions.",
      ],
      button: { label: "View my registrations", url: d.dashboardUrl },
    });
  },

  registrationRefunded(to: string, d: { player: string; amount: string; dashboardUrl?: string }): EmailMessage {
    return message(to, "registration.refunded", `Refund issued for ${d.player}'s registration`, {
      preheader: `${d.amount} refunded to your card.`,
      heading: "Refund issued",
      paragraphs: [`A refund of ${d.amount} for ${d.player}'s registration has been issued to the card you used.`, "It usually appears within 5–10 business days."],
      details: [["Refund", d.amount]],
      button: d.dashboardUrl ? { label: "View my registrations", url: d.dashboardUrl } : undefined,
    });
  },

  squareDisconnected(to: string, d: { by: string | null; merchantName: string | null; reason: string | null; adminUrl: string }): EmailMessage {
    return message(to, "admin.square_disconnected", "Square was disconnected: online payments are paused", {
      preheader: "Families can't pay online until Square is reconnected.",
      heading: "Online payments are paused",
      paragraphs: [
        `The league's Square account${d.merchantName ? ` (${d.merchantName})` : ""} was disconnected ${d.by ? `by ${d.by}` : "from the Square dashboard"}.`,
        ...(d.reason ? [`Reason: ${d.reason}`] : []),
        "Families can't pay online until a Super Admin reconnects Square.",
      ],
      button: { label: "Open payment settings", url: d.adminUrl },
    });
  },

  contactMessage(
    to: string,
    d: { name: string; email: string; phone: string | null; topic: string; message: string; adminUrl: string },
  ): EmailMessage {
    return message(
      to,
      "contact.message",
      `Website message (${d.topic}) from ${d.name}`,
      {
        preheader: d.message.slice(0, 90),
        heading: `New message from ${d.name}`,
        paragraphs: [d.message],
        details: [["From", d.name], ["Email", d.email], ...(d.phone ? ([["Phone", d.phone]] as [string, string][]) : []), ["Topic", d.topic]],
        button: { label: `Reply to ${d.name.split(" ")[0]}`, url: `mailto:${d.email}` },
        secondaryButton: { label: "All messages", url: d.adminUrl },
        footnote: "You can also just hit Reply; it goes to them.",
      },
      { replyTo: d.email },
    );
  },
};
