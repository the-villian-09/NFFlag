import pino from "pino";
import { env } from "../config.js";

/**
 * Structured JSON logs (Cloud Logging parses `severity` and `message`).
 * Sensitive fields are redacted; never log medical data or documents.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  messageKey: "message",
  formatters: {
    level(label) {
      return { severity: label.toUpperCase() };
    },
  },
  redact: {
    paths: [
      "req.headers",
      "req.query",
      "res.headers",
      "*.password",
      "*.newPassword",
      "*.currentPassword",
      "*.code",
      "*.otp",
      "*.secret",
      "*.backupCodes",
      "*.token",
    ],
    censor: "[redacted]",
  },
});
