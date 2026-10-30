/**
 * League tables used from R0/R1: households, seasons, divisions.
 * Players, registrations, orders and payments are added in R1b migrations.
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  phone: text("phone"),
  addressLine1: text("address_line1"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Links guardians (users) to a household. Supports a second guardian later
 * (backlog) without schema change.
 */
export const householdMembers = pgTable(
  "household_members",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    memberRole: text("member_role").notNull().default("primary"), // primary | guardian
    relationship: text("relationship"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] }), index("hm_user_idx").on(t.userId)],
);

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    year: integer("year").notNull(),
    /** planning | registration_open | in_season | playoffs | completed | archived */
    status: text("status").notNull().default("planning"),
    /** Exactly one current season (PRD critical constraint). */
    isCurrent: text("is_current"),
    registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
    registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
    ageCutoffDate: date("age_cutoff_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("one_current_season").on(t.isCurrent).where(sql`${t.isCurrent} is not null`),
    check("is_current_flag", sql`${t.isCurrent} is null or ${t.isCurrent} = 'current'`),
  ],
);

export const divisions = pgTable(
  "divisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** coed | boys | girls — admin-configured (FR-001). */
    genderPolicy: text("gender_policy").notNull().default("coed"),
    /** Eligible birth-date range; null = no bound. Admin still decides (FR-003). */
    birthDateFrom: date("birth_date_from"),
    birthDateTo: date("birth_date_to"),
    eligibilityNotes: text("eligibility_notes"),
    capacity: integer("capacity").notNull(),
    /** Money in integer cents (FR-014). */
    priceCents: integer("price_cents").notNull(),
    rosterMax: integer("roster_max"),
    /** draft | open | full | closed */
    status: text("status").notNull().default("draft"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("division_season_name").on(t.seasonId, t.name),
    check("capacity_nonneg", sql`${t.capacity} >= 0`),
    check("price_nonneg", sql`${t.priceCents} >= 0`),
  ],
);
