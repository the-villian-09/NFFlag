/**
 * League tables used from R0/R1: households, seasons, divisions.
 * R1b adds players, medical details, registrations, payments, refunds and the
 * Square connection.
 */
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
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
    /** TixFlo season pass page (shown as a "Season passes" button on the public schedule). */
    seasonPassUrl: text("season_pass_url"),
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
    /** What a referee is paid per game in this division, in cents (R5). */
    refereeRateCents: integer("referee_rate_cents").notNull().default(0),
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
    /** Promo code discount taken off the division price (before any card fee). */
    discountCents: integer("discount_cents").notNull().default(0),
    promoCodeId: uuid("promo_code_id").references((): AnyPgColumn => promoCodes.id),
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
    discountCents: integer("discount_cents").notNull().default(0),
    promoCodeId: uuid("promo_code_id").references((): AnyPgColumn => promoCodes.id),
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
    /** Where to buy tickets for this game (shown as a "Buy tickets" button). */
    ticketUrl: text("ticket_url"),
    /** How many referees this game needs (R5). */
    refereeSlots: integer("referee_slots").notNull().default(2),
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

/* ------------------------------------------------------- promo codes ---- */

/**
 * A discount code. kind: percent (value = 1–100) or amount (value = cents).
 * appliesTo: registration, staff (coach / team mom fees) or both. Empty
 * divisionIds = every division. Uses are counted from registrations and
 * applications that hold the code (not cancelled or expired).
 */
export const promoCodes = pgTable(
  "promo_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored upper-case; families can type any case. */
    code: text("code").notNull(),
    description: text("description"),
    kind: text("kind").notNull(),
    value: integer("value").notNull(),
    appliesTo: text("applies_to").notNull().default("registration"),
    seasonId: uuid("season_id").references(() => seasons.id),
    divisionIds: jsonb("division_ids").notNull().default([]),
    maxUses: integer("max_uses"),
    onePerFamily: boolean("one_per_family").notNull().default(false),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("promo_code_unique").on(t.code),
    check("promo_kind", sql`${t.kind} in ('percent','amount')`),
    check("promo_value", sql`(${t.kind} = 'percent' and ${t.value} between 1 and 100) or (${t.kind} = 'amount' and ${t.value} > 0)`),
    check("promo_applies", sql`${t.appliesTo} in ('registration','staff','both')`),
  ],
);

/* --------------------------------------------- withdrawal requests ---- */

/**
 * A family asks the league to withdraw a paid registration. status: open,
 * withdrawn (the family took it back), declined (with a note), completed (the
 * league cancelled the registration). One open request per registration.
 */
export const withdrawalRequests = pgTable(
  "withdrawal_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason"),
    status: text("status").notNull().default("open"),
    adminNote: text("admin_note"),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("withdrawal_one_open").on(t.registrationId).where(sql`${t.status} = 'open'`),
    index("withdrawal_status_idx").on(t.status, t.createdAt),
    check("withdrawal_status", sql`${t.status} in ('open','withdrawn','declined','completed')`),
  ],
);

/* ---------------------------------------------------------------- R5 ---- */

/**
 * Referee sign-up for a season. Approval needs a cleared background check, a
 * verified certification that hasn't expired, and the league's minimum age.
 *
 * submitted → approved | rejected; withdrawn; approved → revoked.
 */
export const refereeApplications = pgTable(
  "referee_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(),
    birthDate: date("birth_date").notNull(),
    experience: text("experience"),
    /** e.g. "NFL FLAG Official", "FHSAA" */
    certification: text("certification").notNull(),
    certificationExpiresOn: date("certification_expires_on"),
    certificationVerifiedBy: text("certification_verified_by").references(() => user.id, { onDelete: "set null" }),
    certificationVerifiedAt: timestamp("certification_verified_at", { withTimezone: true }),
    /** submitted | approved | rejected | withdrawn | revoked */
    status: text("status").notNull().default("submitted"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ref_app_season_status_idx").on(t.seasonId, t.status),
    uniqueIndex("ref_app_one_active").on(t.seasonId, t.userId).where(sql`${t.status} in ('submitted','approved')`),
    check("ref_app_status", sql`${t.status} in ('submitted','approved','rejected','withdrawn','revoked')`),
  ],
);

/**
 * A referee's Stripe connected account (Express-style, managed through
 * embedded components on our site). Stripe holds their tax ID and bank
 * details; we keep only the account id and its status.
 */
export const refereeAccounts = pgTable("referee_accounts", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  stripeAccountId: text("stripe_account_id").notNull().unique(),
  /** test | live */
  environment: text("environment").notNull(),
  detailsSubmitted: boolean("details_submitted").notNull().default(false),
  /** Stripe's "transfers" capability is active: we can send them money. */
  transfersActive: boolean("transfers_active").notNull().default(false),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(false),
  /** Number of items Stripe still needs from them. */
  requirementsDue: integer("requirements_due").notNull().default(0),
  disabledReason: text("disabled_reason"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One payout to one referee: the money for a set of games, sent as a Stripe
 * transfer into their connected account (their bank gets it on Stripe's
 * payout schedule, or right away with an instant payout they start).
 *
 * pending (not sent yet: account not ready, or outcome being confirmed) → paid | failed (Stripe refused; retry)
 * → void (cancelled by an admin; its games are owed again).
 */
export const refereePayouts = pgTable(
  "referee_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    amountCents: integer("amount_cents").notNull(),
    /** pending | paid | failed | void */
    status: text("status").notNull().default("pending"),
    environment: text("environment").notNull(),
    stripeTransferId: text("stripe_transfer_id").unique(),
    /** Same key on every attempt, so a retry can never send the money twice. */
    idempotencyKey: text("idempotency_key").notNull(),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ref_payouts_user_idx").on(t.userId, t.createdAt),
    index("ref_payouts_status_idx").on(t.status),
    check("ref_payouts_status", sql`${t.status} in ('pending','paid','failed','void')`),
    check("ref_payouts_amount", sql`${t.amountCents} > 0`),
  ],
);

/**
 * A referee on a game: assigned by an admin or claimed by the referee.
 * assigned → worked (paid through a payout) | no_show; removed.
 */
export const gameOfficials = pgTable(
  "game_officials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    /** assigned | worked | no_show | removed */
    status: text("status").notNull().default("assigned"),
    /** assigned (by an admin) | claimed (by the referee) */
    source: text("source").notNull().default("assigned"),
    /** Pay for this game; starts at the division's rate. */
    rateCents: integer("rate_cents").notNull(),
    payoutId: uuid("payout_id").references(() => refereePayouts.id),
    assignedBy: text("assigned_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("game_officials_one").on(t.gameId, t.userId).where(sql`${t.status} <> 'removed'`),
    index("game_officials_user_idx").on(t.userId),
    index("game_officials_payout_idx").on(t.payoutId),
    check("game_officials_status", sql`${t.status} in ('assigned','worked','no_show','removed')`),
    check("game_officials_rate", sql`${t.rateCents} >= 0`),
  ],
);

/* ------------------------------------------------------- Documents ---- */

/**
 * Uploaded files. Children: birth certificate (kept for later seasons),
 * insurance card and headshot (each season). Coaches, team moms and referees:
 * a headshot each season. The file itself is in private storage (Cloud
 * Storage in production); only the API reads it, after a permission check.
 * Replacing a file marks the old row replaced (kept for the audit trail).
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** birth_certificate | insurance_card | player_photo | staff_photo */
    kind: text("kind").notNull(),
    playerId: uuid("player_id").references(() => players.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** The season it's for; null for a birth certificate (good for every season). */
    seasonId: uuid("season_id").references(() => seasons.id),
    storageKey: text("storage_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_player_idx").on(t.playerId, t.kind),
    index("documents_user_idx").on(t.userId, t.kind),
    check("documents_kind", sql`${t.kind} in ('birth_certificate','insurance_card','player_photo','staff_photo')`),
    check("documents_owner", sql`(${t.kind} = 'staff_photo' and ${t.userId} is not null and ${t.playerId} is null) or (${t.kind} <> 'staff_photo' and ${t.playerId} is not null and ${t.userId} is null)`),
    check("documents_season", sql`(${t.kind} = 'birth_certificate') = (${t.seasonId} is null)`),
    // One current file per child/person, kind and season.
    uniqueIndex("documents_one_current")
      .on(t.kind, sql`coalesce(${t.playerId}::text, ${t.userId})`, sql`coalesce(${t.seasonId}::text, '')`)
      .where(sql`${t.replacedAt} is null`),
  ],
);
