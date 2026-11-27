/**
 * Team spaces (Nov 26): each team's private feed, chat, RSVPs and alerts.
 * Who belongs to a team comes from the roster and team staff (see
 * modules/team-chat/membership.ts); nothing here stores membership.
 *
 *   team_messages        feed posts, alerts and chat (team channel or staff-only)
 *   team_message_reads   who has seen a post or alert ("seen by 12 of 14")
 *   team_channel_reads   last time someone opened a channel (unread counts)
 *   team_rsvps           going / maybe / can't, per child per game or practice
 *   team_prefs           per person, per team: muted
 *   notification_prefs   per person: quiet overnight (9 PM – 7 AM)
 *   team_message_reports a member flagged a message for league admins
 *   push_subscriptions   browsers/phones that get push alerts
 */
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { players, teams } from "./league.js";

export const teamMessages = pgTable(
  "team_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    /** team (everyone on the team) | staff (coaches and team mom only) */
    channel: text("channel").notNull().default("team"),
    /** chat | post (coach update in the feed) | alert (urgent: pushes through quiet hours, also emailed) */
    kind: text("kind").notNull().default("chat"),
    body: text("body").notNull(),
    /** A post can carry an RSVP for a game or practice. */
    eventType: text("event_type"),
    eventId: uuid("event_id"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    index("team_messages_team_time_idx").on(t.teamId, t.channel, t.createdAt),
    check("team_messages_channel", sql`${t.channel} in ('team','staff')`),
    check("team_messages_kind", sql`${t.kind} in ('chat','post','alert')`),
    check("team_messages_event_type", sql`${t.eventType} is null or ${t.eventType} in ('game','practice')`),
  ],
);

export const teamMessageReads = pgTable(
  "team_message_reads",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => teamMessages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

export const teamChannelReads = pgTable(
  "team_channel_reads",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** feed | chat | staff */
    view: text("view").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId, t.view] })],
);

export const teamRsvps = pgTable(
  "team_rsvps",
  {
    eventType: text("event_type").notNull(),
    eventId: uuid("event_id").notNull(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    /** yes | maybe | no */
    status: text("status").notNull(),
    note: text("note"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventType, t.eventId, t.playerId] }),
    check("team_rsvps_status", sql`${t.status} in ('yes','maybe','no')`),
    check("team_rsvps_event_type", sql`${t.eventType} in ('game','practice')`),
  ],
);

/** Per person, across all their teams. */
export const notificationPrefs = pgTable("notification_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Hold everything but alerts from 9 PM to 7 AM Eastern. Off unless the person turns it on. */
  quietOvernight: boolean("quiet_overnight").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamPrefs = pgTable(
  "team_prefs",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    muted: boolean("muted").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const teamMessageReports = pgTable(
  "team_message_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => teamMessages.id, { onDelete: "cascade" }),
    reporterUserId: text("reporter_user_id").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [index("team_reports_open_idx").on(t.resolvedAt, t.createdAt)],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("push_endpoint_unique").on(t.endpoint), index("push_user_idx").on(t.userId)],
);
