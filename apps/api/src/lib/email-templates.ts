/** Plain transactional templates. Copy is placeholder until league approves wording. */
import type { EmailMessage } from "./email.js";

export const templates = {
  verifyEmail(to: string, url: string): EmailMessage {
    return {
      to,
      template: "auth.verify_email",
      subject: "Confirm your NFFL account",
      text: `Welcome to the North Florida Flag League.\n\nConfirm your email address to finish creating your account:\n${url}\n\nIf you didn't create an account, you can ignore this email.`,
    };
  },
  resetPassword(to: string, url: string): EmailMessage {
    return {
      to,
      template: "auth.reset_password",
      subject: "Reset your NFFL password",
      text: `We received a request to reset your password.\n\nReset it here (link expires in 1 hour):\n${url}\n\nIf you didn't ask for this, you can ignore this email; your password won't change.`,
    };
  },
  loginCode(to: string, code: string): EmailMessage {
    return {
      to,
      template: "auth.login_code",
      subject: `Your NFFL sign-in code: ${code}`,
      text: `Your NFFL sign-in code is ${code}.\n\nIt expires in 10 minutes. Never share this code; NFFL staff will never ask for it.`,
    };
  },
  registrationPaid(to: string, d: { player: string; division: string; season: string; total: string; receiptUrl: string | null; dashboardUrl: string }): EmailMessage {
    return {
      to,
      template: "registration.paid",
      subject: `Registration received: ${d.player}`,
      text: `Thanks! We received ${d.player}'s registration for ${d.division} (${d.season}).\n\nAmount paid: ${d.total}${d.receiptUrl ? `\nCard receipt: ${d.receiptUrl}` : ""}\n\nWhat happens next: the league reviews each registration (age and division). We'll email you when it's approved.\n\nView your registrations: ${d.dashboardUrl}`,
    };
  },
  registrationDecision(to: string, d: { player: string; division: string; approved: boolean; reason: string | null; dashboardUrl: string }): EmailMessage {
    return {
      to,
      template: d.approved ? "registration.approved" : "registration.rejected",
      subject: d.approved ? `${d.player} is registered for ${d.division}` : `Update on ${d.player}'s registration`,
      text: d.approved
        ? `Good news: ${d.player}'s registration for ${d.division} has been approved.\n\nWe'll be in touch with team and schedule details before the season starts.\n\n${d.dashboardUrl}`
        : `We weren't able to accept ${d.player}'s registration for ${d.division}.${d.reason ? `\n\nReason: ${d.reason}` : ""}\n\nIf a refund applies, it goes back to the card you used (usually 5–10 business days). Reply to the league with any questions.\n\n${d.dashboardUrl}`,
    };
  },
  registrationRefunded(to: string, d: { player: string; amount: string }): EmailMessage {
    return {
      to,
      template: "registration.refunded",
      subject: `Refund issued for ${d.player}'s registration`,
      text: `A refund of ${d.amount} for ${d.player}'s registration has been issued to the card you used. It usually appears within 5–10 business days.`,
    };
  },
  squareDisconnected(to: string, d: { by: string | null; merchantName: string | null; reason: string | null; adminUrl: string }): EmailMessage {
    return {
      to,
      template: "admin.square_disconnected",
      subject: "Square was disconnected: online payments are paused",
      text: `The league's Square account${d.merchantName ? ` (${d.merchantName})` : ""} was disconnected ${d.by ? `by ${d.by}` : "from the Square dashboard"}.${d.reason ? `\nReason: ${d.reason}` : ""}\n\nFamilies can't pay online until a Super Admin reconnects Square:\n${d.adminUrl}`,
    };
  },
};
