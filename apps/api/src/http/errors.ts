import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";

/** Stable error codes the front end can switch on. */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "SESSION_IDLE"
  | "EMAIL_NOT_VERIFIED"
  | "MFA_ENROLLMENT_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "FEATURE_DISABLED"
  | "INTERNAL";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.ctx?.requestId;
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid.",
        requestId,
        fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, requestId, ...err.details } });
    return;
  }
  logger.error({ err, requestId }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong.", requestId } });
};
