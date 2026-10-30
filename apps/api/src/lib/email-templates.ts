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
};
