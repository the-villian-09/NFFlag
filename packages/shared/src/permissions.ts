/**
 * Permission catalog. Code checks permissions, never role names, so new roles
 * (coach, scorekeeper, ...) are data, not code changes.
 *
 * Add a permission here when a release adds a capability; then grant it to
 * roles in DEFAULT_ROLE_PERMISSIONS (seeded) or through the admin UI.
 */
export const PERMISSIONS = [
  // Platform
  "platform.settings.manage",
  "platform.roles.manage",
  "platform.flags.manage",
  "platform.audit.read",
  "platform.admins.manage",
  "platform.mfa.reset",

  // Seasons & divisions (R1)
  "seasons.read",
  "seasons.manage",

  // Registrations (R1)
  "registrations.read",
  "registrations.manage",
  "registrations.export",
  "eligibility.decide",
  "documents.read",
  "medical.read",

  // Payments (R1/R2)
  "payments.read",
  "refunds.issue",

  // Content (R1)
  "content.manage",

  // Staff (R2)
  "staff.applications.review",

  // Teams & rosters (R3)
  "teams.manage",
  "roster.read",
  "roster.request_change",
  "draft.run",

  // Scheduling (R3/R4)
  "practices.manage",
  "games.manage",
  "scores.enter",

  // Communications (R4)
  "announcements.send",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_KEYS = [
  "super_admin",
  "league_admin",
  "head_coach",
  "assistant_coach",
  "team_manager",
  "scorekeeper",
  "parent",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/** Roles that must use an authenticator app (TOTP) on every login. */
export const STAFF_ROLES: readonly RoleKey[] = [
  "super_admin",
  "league_admin",
  "head_coach",
  "assistant_coach",
  "team_manager",
  "scorekeeper",
];

/** Roles allowed into /admin. */
export const ADMIN_PORTAL_ROLES: readonly RoleKey[] = ["super_admin", "league_admin"];

/**
 * Default grants (PRD section 3, PROPOSED defaults). Seeded into role_permissions;
 * admins can change them later without a deploy.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  super_admin: PERMISSIONS,
  league_admin: [
    "seasons.read",
    "seasons.manage",
    "registrations.read",
    "registrations.manage",
    "registrations.export",
    "eligibility.decide",
    "documents.read",
    "medical.read",
    "payments.read",
    "refunds.issue",
    "content.manage",
    "staff.applications.review",
    "teams.manage",
    "roster.read",
    "draft.run",
    "practices.manage",
    "games.manage",
    "scores.enter",
    "announcements.send",
    "platform.audit.read",
  ],
  head_coach: ["roster.read", "roster.request_change", "practices.manage", "announcements.send"],
  assistant_coach: ["roster.read", "practices.manage"],
  team_manager: ["roster.read", "announcements.send"],
  scorekeeper: ["scores.enter"],
  parent: [],
};
