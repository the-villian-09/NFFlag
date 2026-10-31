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

  waitlistJoined(to: string, d: { player: string; division: string; position: number; dashboardUrl: string }): EmailMessage {
    return message(to, "waitlist.joined", `${d.player} is on the ${d.division} waitlist`, {
      preheader: `Number ${d.position} in line.`,
      heading: "You're on the waitlist",
      paragraphs: [
        `${d.player} is on the waitlist for ${d.division}.`,
        "If a spot opens, we'll email you an offer. You'll have a limited time to claim it and pay, so keep an eye on your inbox.",
      ],
      details: [["Place in line", `#${d.position}`]],
      button: { label: "View my account", url: d.dashboardUrl },
    });
  },

  waitlistOffered(to: string, d: { player: string; division: string; deadline: string; claimUrl: string }): EmailMessage {
    return message(to, "waitlist.offered", `A spot opened up for ${d.player} in ${d.division}`, {
      preheader: `Claim it by ${d.deadline}.`,
      heading: "A spot opened up!",
      paragraphs: [
        `Good news: a spot opened up in ${d.division}, and it's being held for ${d.player}.`,
        `Claim it by ${d.deadline}. After that, it goes to the next family on the waitlist.`,
      ],
      details: [["Claim by", d.deadline]],
      button: { label: "Claim the spot", url: d.claimUrl },
    });
  },

  waitlistExpired(to: string, d: { player: string; division: string; dashboardUrl: string }): EmailMessage {
    return message(to, "waitlist.offer_expired", `Waitlist offer expired: ${d.player}`, {
      preheader: "The held spot was passed to the next family.",
      heading: "Your offer expired",
      paragraphs: [
        `The spot we held for ${d.player} in ${d.division} wasn't claimed in time, so it has gone to the next family on the waitlist.`,
        "If you still want to play, contact the league.",
      ],
      button: { label: "View my account", url: d.dashboardUrl },
    });
  },

  volunteerSubmitted(to: string, d: { role: string; season: string; amount: string | null; fee: string; accountUrl: string }): EmailMessage {
    return message(to, "staff.application_submitted", `Application received: ${d.role}`, {
      preheader: "Next: your background check.",
      heading: "Thanks for applying!",
      paragraphs: [
        `We received your application to serve as ${d.role.toLowerCase()} for ${d.season}.`,
        "Next, the league will contact you about the background check required for coaches and team staff who work with children. You'll be approved once it's cleared.",
        ...(d.amount ? [`Your ${d.fee.toLowerCase()} of ${d.amount} was paid. It's refunded if your application isn't approved.`] : []),
      ],
      button: { label: "View my application", url: d.accountUrl },
    });
  },

  volunteerDecision(to: string, d: { role: string; season: string; approved: boolean; reason: string | null; accountUrl: string }): EmailMessage {
    if (d.approved) {
      return message(to, "staff.application_approved", `You're approved: ${d.role}`, {
        preheader: `Welcome to the ${d.season} coaching staff.`,
        heading: "You're approved!",
        paragraphs: [`You're approved as ${d.role.toLowerCase()} for ${d.season}. Thank you for being part of the season.`, "We'll be in touch about team assignments and the draft."],
        button: { label: "Open my account", url: d.accountUrl },
      });
    }
    return message(to, "staff.application_rejected", `Update on your ${d.role.toLowerCase()} application`, {
      preheader: "An update on your application.",
      heading: "Application not approved",
      paragraphs: [
        `We weren't able to approve your application to serve as ${d.role.toLowerCase()} this season.`,
        ...(d.reason ? [`Reason: ${d.reason}`] : []),
        "Any fee you paid is refunded to your card (usually 5–10 business days). Reply to this email with any questions.",
      ],
      button: { label: "Open my account", url: d.accountUrl },
    });
  },

  volunteerRefunded(to: string, d: { amount: string; fee: string }): EmailMessage {
    return message(to, "staff.application_refunded", `${d.fee} refunded`, {
      preheader: `${d.amount} refunded to your card.`,
      heading: "Refund issued",
      paragraphs: [`A refund of ${d.amount} for your ${d.fee.toLowerCase()} has been issued to the card you used. It usually appears within 5–10 business days.`],
      details: [["Refund", d.amount]],
    });
  },
};
