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

export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    if (env.NODE_ENV === "development") {
      logger.info({ to: message.to, subject: message.subject, text: message.text }, "email (dev, not sent)");
    }
  }
  last(to: string, template?: string) {
    return [...this.sent].reverse().find((m) => m.to === to && (!template || m.template === template));
  }
}

class ResendEmailSender implements EmailSender {
  private client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async send(message: EmailMessage) {
    const subjectPrefix = env.APP_ENV === "prod" ? "" : `[${env.APP_ENV}] `;
    const { error } = await this.client.emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: subjectPrefix + message.subject,
      text: message.text,
      html: message.html,
      tags: [{ name: "template", value: message.template }],
    });
    if (error) throw new Error(`Resend error: ${error.message}`);
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
