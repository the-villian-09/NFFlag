import { z } from "zod";

/**
 * NFFL Text Alerts (Twilio). The consent wording is stored with each opt-in
 * (by version), because carriers can ask how and when someone agreed.
 */
export const SMS_PROGRAM = "NFFL Text Alerts";
export const SMS_CONSENT_VERSION = "2026-11-02";
export const SMS_CONSENT_TEXT =
  "Yes, text me NFFL Text Alerts at this number: game-day alerts such as rainouts and schedule changes, registration and payment reminders, and messages from my child's coach or team. Message frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to cancel. Consent is not a condition of registration or purchase.";

/** US mobile numbers only, stored as +1XXXXXXXXXX. Returns null if it isn't one. */
export function toE164(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10 || /^[01]/.test(ten) || /^\d{3}[01]/.test(ten)) return null;
  return `+1${ten}`;
}

/** "(904) 555-0142" */
export const formatPhone = (e164: string) => {
  const d = e164.replace(/^\+1/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
};

export const smsPrefInput = z.object({
  phone: z.string().trim().max(32),
  /** Ticked the consent box. */
  subscribe: z.boolean(),
});
