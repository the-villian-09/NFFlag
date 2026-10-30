/**
 * Email provider adapter. Resend in staging/prod; an in-memory sender in tests
 * and in local dev when no RESEND_API_KEY is set (messages are logged).
 * SMS (Twilio) arrives in R4 as a sibling adapter with the same shape.
 */
import { Resend } from "resend";
import { env } from "../config.js";
import { logger } from "./logger.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Logical template name, for delivery tracking. */
  template: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Used in tests, and wherever no RESEND_API_KEY is configured.
 *  - dev / staging: the email (with its link or code) is written to the log
 *    instead of being sent, so accounts can still be confirmed.
 *  - prod: never logs content (it holds sign-in links); logs an error so a
 *    missing key is noticed.
 */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    if (env.NODE_ENV === "test") return;
    if (env.APP_ENV === "prod") {
      logger.error({ to: message.to, template: message.template }, "email NOT sent: RESEND_API_KEY is not configured");
      return;
    }
    logger.warn(
      { to: message.to, subject: message.subject, emailText: message.text, template: message.template },
      `email not sent (no RESEND_API_KEY) — ${message.subject}`,
    );
  }
  last(to: string, template?: string) {
    return [...this.sent].reverse().find((m) => m.to === to && (!template || m.template === template));
  }
}

class ResendEmailSender implements EmailSender {
  private client: Resend;
  constructor(apiKey: string) {
    // Trim: a pasted key often carries a trailing newline.
    this.client = new Resend(apiKey.trim());
  }
  async send(message: EmailMessage) {
    const subjectPrefix = env.APP_ENV === "prod" ? "" : `[${env.APP_ENV}] `;
    const { data, error } = await this.client.emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: subjectPrefix + message.subject,
      text: message.text,
      html: message.html,
      tags: [{ name: "template", value: message.template.replace(/[^A-Za-z0-9_-]/g, "_") }],
    });
    if (error) {
      logger.error({ template: message.template, resendError: error.message }, `Resend error: ${error.message}`);
      throw new Error(`Resend error: ${error.message}`);
    }
    logger.info({ template: message.template, resendId: data?.id }, "email sent via Resend");
  }
}

let sender: EmailSender =
  env.RESEND_API_KEY && env.NODE_ENV !== "test" ? new ResendEmailSender(env.RESEND_API_KEY) : new MemoryEmailSender();

export function getEmailSender(): EmailSender {
  return sender;
}

/** Tests swap in their own sender. */
export function setEmailSender(next: EmailSender) {
  sender = next;
}
