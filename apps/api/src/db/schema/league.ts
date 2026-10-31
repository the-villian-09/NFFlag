/**
 * League tables used from R0/R1: households, seasons, divisions.
 * R1b adds players, medical details, registrations, payments, refunds and the
 * Square connection.
 */
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
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

/* ---------------------------------------------------------------- R1b ---- */

export const players = pgTable(
  "players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    preferredName: text("preferred_name"),
    birthDate: date("birth_date").notNull(),
    /** boy | girl — used to match a division's gender policy. */
    gender: text("gender").notNull(),
    shirtSize: text("shirt_size"),
    school: text("school"),
    grade: text("grade"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("players_household_idx").on(t.householdId), check("player_gender", sql`${t.gender} in ('boy','girl')`)],
);

/**
 * Medical and emergency details, kept apart from `players` so ordinary queries
 * never touch them. Only users with `medical.read` see these in the admin portal,
 * and the audit log redacts them by key name.
 */
export const playerMedical = pgTable("player_medical", {
  playerId: uuid("player_id")
    .primaryKey()
    .references(() => players.id, { onDelete: "cascade" }),
  allergies: text("allergies"),
  medicalConditions: text("medical_conditions"),
  medications: text("medications"),
  medicalInstructions: text("medical_instructions"),
  physicianName: text("physician_name"),
  physicianPhone: text("physician_phone"),
  emergencyContactName: text("emergency_contact_name").notNull(),
  emergencyContactPhone: text("emergency_contact_phone").notNull(),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Statuses that hold (or used) a spot in a division. */
export const ACTIVE_REGISTRATION_STATUSES = ["pending_payment", "processing", "paid", "approved"] as const;

export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => divisions.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    submittedBy: text("submitted_by").references(() => user.id, { onDelete: "set null" }),
    /**
     * pending_payment → processing → paid (awaiting review) → approved | rejected
     * Also: expired (hold ran out unpaid), cancelled (by family or admin).
     */
    status: text("status").notNull().default("pending_payment"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    /** Division price, processing fee charged to the family (0 when the league absorbs it), and total. */
    priceCents: integer("price_cents").notNull(),
    feeCents: integer("fee_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    /** [{ slug, title, version, sha256, signerName, acceptedAt }] */
    waivers: jsonb("waivers").notNull().default([]),
    paymentError: text("payment_error"),
    /** The request sent to Square while `processing` (same idempotency key is re-sent by the worker to learn the outcome). */
    paymentRequest: jsonb("payment_request"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    decision: text("decision"), // approved | rejected
    decisionReason: text("decision_reason"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reg_division_status_idx").on(t.divisionId, t.status),
    index("reg_household_idx").on(t.householdId),
    // One live registration per child per season.
    uniqueIndex("reg_one_active_per_player")
      .on(t.seasonId, t.playerId)
      .where(sql`${t.status} in ('pending_payment','processing','paid','approved')`),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** What the payment is for: a player registration, or a volunteer application (R2). Exactly one is set. */
    registrationId: uuid("registration_id").references(() => registrations.id),
    applicationId: uuid("application_id").references((): AnyPgColumn => volunteerApplications.id),
    provider: text("provider").notNull().default("square"),
    /** sandbox | production */
    providerEnvironment: text("provider_environment").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    merchantId: text("merchant_id"),
    locationId: text("location_id"),
    /** Square status: APPROVED | PENDING | COMPLETED | CANCELED | FAILED */
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    refundedCents: integer("refunded_cents").notNull().default(0),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    receiptUrl: text("receipt_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_provider_id").on(t.providerPaymentId),
    index("payments_reg_idx").on(t.registrationId),
    index("payments_app_idx").on(t.applicationId),
    check("payments_one_owner", sql`(${t.registrationId} is null) <> (${t.applicationId} is null)`),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    providerRefundId: text("provider_refund_id"),
    /** PENDING | COMPLETED | REJECTED | FAILED */
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    issuedBy: text("issued_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("refunds_provider_id").on(t.providerRefundId), index("refunds_payment_idx").on(t.paymentId)],
);

/**
 * The league's Square seller account, connected by a Super Admin through Square
 * OAuth. One row (id = 'default'). Tokens are encrypted at rest (lib/crypto.ts).
 */
export const squareConnection = pgTable("square_connection", {
  id: text("id").primaryKey().default("default"),
  environment: text("environment").notNull(),
  merchantId: text("merchant_id").notNull(),
  merchantName: text("merchant_name"),
  locationId: text("location_id"),
  locationName: text("location_name"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  scopes: text("scopes"),
  connectedBy: text("connected_by").references(() => user.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  lastRefreshError: text("last_refresh_error"),
});

/** One-time OAuth `state` values (CSRF protection for Connect Square). */
export const squareOauthStates = pgTable("square_oauth_states", {
  state: text("state").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Square webhook event ids already handled (deliveries can repeat). */
export const squareWebhookEvents = pgTable("square_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------------------------------------------------- R2 ---- */

/**
 * Waitlist for a full division (R2). First come, first served by created_at.
 * waiting → offered (spot held until offer_expires_at) → accepted (became a
 * registration) | expired | declined | removed.
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => divisions.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    status: text("status").notNull().default("waiting"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
    registrationId: uuid("registration_id").references(() => registrations.id),
    removedReason: text("removed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("waitlist_division_status_idx").on(t.divisionId, t.status, t.createdAt),
    index("waitlist_household_idx").on(t.householdId),
    // One live waitlist place per child per season.
    uniqueIndex("waitlist_one_active_per_player").on(t.seasonId, t.playerId).where(sql`${t.status} in ('waiting','offered')`),
  ],
);

/**
 * Coach / team manager applications (R2). The volunteer fee is paid when
 * applying (refunded if not approved). A cleared background check is required
 * before approval; approving grants the role for that season.
 *
 * pending_payment → processing → submitted → approved | rejected; withdrawn.
 */
export const volunteerApplications = pgTable(
  "volunteer_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** head_coach | assistant_coach | team_manager */
    roleKey: text("role_key").notNull(),
    preferredDivisionId: uuid("preferred_division_id").references(() => divisions.id),
    /** The applicant's own child, if they'd like to be on that child's team. */
    playerId: uuid("player_id").references(() => players.id),
    phone: text("phone").notNull(),
    experience: text("experience"),
    notes: text("notes"),
    shirtSize: text("shirt_size"),
    /** [{ slug, title, version, sha256, signerName, acceptedAt }] */
    agreements: jsonb("agreements").notNull().default([]),
    status: text("status").notNull().default("pending_payment"),
    feeCents: integer("fee_cents").notNull().default(0),
    processingFeeCents: integer("processing_fee_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    paymentRequest: jsonb("payment_request"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    paymentError: text("payment_error"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** not_started | pending | cleared | not_cleared */
    screeningStatus: text("screening_status").notNull().default("not_started"),
    screeningProvider: text("screening_provider"),
    screeningCompletedOn: date("screening_completed_on"),
    screeningExpiresOn: date("screening_expires_on"),
    screeningNotes: text("screening_notes"),
    screeningUpdatedBy: text("screening_updated_by").references(() => user.id, { onDelete: "set null" }),
    screeningUpdatedAt: timestamp("screening_updated_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    roleAssignmentId: uuid("role_assignment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("va_season_status_idx").on(t.seasonId, t.status),
    index("va_user_idx").on(t.userId),
    uniqueIndex("va_one_active_per_role")
      .on(t.seasonId, t.userId, t.roleKey)
      .where(sql`${t.status} in ('pending_payment','processing','submitted','approved')`),
    check("va_role", sql`${t.roleKey} in ('head_coach','assistant_coach','team_manager')`),
  ],
);

/* ---------------------------------------------------------------- R3 ---- */

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => divisions.id),
    name: text("name").notNull(),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("team_division_name").on(t.divisionId, t.name), index("teams_division_idx").on(t.divisionId)],
);

/** Coaches and team moms on a team. Each row also has a team-scoped role grant (role_assignment_id). */
export const teamStaff = pgTable(
  "team_staff",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** head_coach | assistant_coach | team_manager */
    roleKey: text("role_key").notNull(),
    roleAssignmentId: uuid("role_assignment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_staff_user_idx").on(t.userId),
    // One head coach per team.
    uniqueIndex("team_one_head_coach").on(t.teamId).where(sql`${t.roleKey} = 'head_coach'`),
  ],
);

/**
 * A player on a team. source: coach_child (placed before the draft; counts as
 * that team's earliest picks), draft (pick_number = overall slot), admin (placed
 * or moved by an admin after the draft).
 */
export const rosterEntries = pgTable(
  "roster_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => divisions.id),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id),
    source: text("source").notNull(),
    pickNumber: integer("pick_number"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("roster_one_team_per_registration").on(t.registrationId),
    uniqueIndex("roster_unique_pick").on(t.divisionId, t.pickNumber).where(sql`${t.pickNumber} is not null`),
    index("roster_team_idx").on(t.teamId),
  ],
);

/** One draft per division. order = team ids for round 1 (snake after). */
export const drafts = pgTable("drafts", {
  divisionId: uuid("division_id")
    .primaryKey()
    .references(() => divisions.id),
  /** setup | live | complete */
  status: text("status").notNull().default("setup"),
  order: jsonb("order").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Rosters are visible to coaches and families once published. */
  publishedAt: timestamp("published_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------------------------------------------------- R4 ---- */

/**
 * A game between two teams in the same division. Times are stored in UTC and
 * entered/shown in league time (America/New_York). Final games count toward
 * the public standings.
 */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => divisions.id),
    homeTeamId: uuid("home_team_id")
      .notNull()
      .references(() => teams.id),
    awayTeamId: uuid("away_team_id")
      .notNull()
      .references(() => teams.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    location: text("location").notNull(),
    /** scheduled | final | cancelled | postponed */
    status: text("status").notNull().default("scheduled"),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("games_division_time_idx").on(t.divisionId, t.startsAt),
    index("games_home_idx").on(t.homeTeamId),
    index("games_away_idx").on(t.awayTeamId),
    check("games_two_teams", sql`${t.homeTeamId} <> ${t.awayTeamId}`),
    check("games_status", sql`${t.status} in ('scheduled','final','cancelled','postponed')`),
    check("games_final_has_score", sql`${t.status} <> 'final' or (${t.homeScore} is not null and ${t.awayScore} is not null)`),
    check("games_scores_nonneg", sql`coalesce(${t.homeScore}, 0) >= 0 and coalesce(${t.awayScore}, 0) >= 0`),
  ],
);

/** A team practice, set by the team's coaches. Visible to the team's families. */
export const practices = pgTable(
  "practices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    location: text("location").notNull(),
    notes: text("notes"),
    /** scheduled | cancelled */
    status: text("status").notNull().default("scheduled"),
    /** Practices added together as a weekly repeat share a series id. */
    seriesId: uuid("series_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("practices_series_idx").on(t.seriesId),
    index("practices_team_time_idx").on(t.teamId, t.startsAt),
    check("practices_status", sql`${t.status} in ('scheduled','cancelled')`),
    check("practices_duration", sql`${t.durationMinutes} between 15 and 300`),
  ],
);

/**
 * An email announcement. audience: team (one team's families and staff),
 * division, or league (every family registered this season and all team staff).
 */
export const announcements = pgTable(
  "announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    audience: text("audience").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    divisionId: uuid("division_id").references(() => divisions.id),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sentBy: text("sent_by").references(() => user.id, { onDelete: "set null" }),
    recipientCount: integer("recipient_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("announcements_team_idx").on(t.teamId, t.createdAt),
    index("announcements_season_idx").on(t.seasonId, t.createdAt),
    check("announcements_audience", sql`${t.audience} in ('team','division','league')`),
  ],
);
