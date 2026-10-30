/**
 * Platform tables: permissions, roles, audit, outbox, feature flags.
 * These are the extension points every later release plugs into.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { session, user } from "./auth.js";

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** Staff roles must enroll an authenticator app (TOTP). */
  requiresTotp: boolean("requires_totp").notNull().default(false),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description"),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

/**
 * A user's roles. scope_type/scope_id narrow a grant to one season or team
 * (e.g. head_coach of team X); null scope = league-wide.
 */
export const userRoleAssignments = pgTable(
  "user_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key),
    scopeType: text("scope_type"), // null | 'season' | 'team'
    scopeId: uuid("scope_id"),
    grantedBy: text("granted_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("ura_user_idx").on(t.userId),
    uniqueIndex("ura_active_unique")
      .on(t.userId, t.roleKey, sql`coalesce(${t.scopeType}, '')`, sql`coalesce(${t.scopeId}::text, '')`)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Append-only. A trigger (see migration) blocks UPDATE and DELETE. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_target_idx").on(t.targetType, t.targetId),
    index("audit_actor_idx").on(t.actorUserId),
    index("audit_created_idx").on(t.createdAt),
  ],
);

/**
 * Transactional outbox: written in the same DB transaction as the change it
 * describes; a worker delivers it to subscribers (email, SMS, TixFlo, ...).
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventName: text("event_name").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** Prevents publishing the same logical event twice. */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("outbox_pending_idx").on(t.availableAt).where(sql`${t.processedAt} is null and ${t.deadAt} is null`)],
);

/** Feature flags: every release ships dark and is turned on per environment. */
export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin-portal idle timeout tracking (durable across Cloud Run instances). */
export const sessionActivity = pgTable("session_activity", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => session.id, { onDelete: "cascade" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
