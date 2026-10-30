/**
 * Audit log writer (FR-038). Call inside the same transaction as the change.
 * Sensitive values are redacted before they are stored.
 */
import type { DbOrTx } from "../../db/client.js";
import { auditLogs } from "../../db/schema/index.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "backupCodes",
  "token",
  "code",
  "otp",
  "allergies",
  "medicalConditions",
  "medications",
  "medicalInstructions",
  "physicianName",
  "physicianPhone",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
}

export async function writeAudit(conn: DbOrTx, entry: AuditEntry) {
  await conn.insert(auditLogs).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    reason: entry.reason ?? null,
    requestId: entry.requestId ?? null,
    ipAddress: entry.ipAddress ?? null,
  });
}
