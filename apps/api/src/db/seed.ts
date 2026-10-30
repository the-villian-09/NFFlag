/**
 * Idempotent seed: permission catalog, roles and default grants, feature flags.
 * `--sample` also adds a placeholder season + divisions for dev/staging only.
 *
 * Safe to re-run on every deploy: it inserts missing rows and never removes
 * grants an admin changed by hand.
 */
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_KEYS, type RoleKey } from "@nffl/shared";
import { sql } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, pool, type DbOrTx } from "./client.js";
import { seedContent } from "../modules/content/routes.js";
import { seedPaymentSettings } from "../modules/registration/settings.js";
import { divisions, featureFlags, permissions, rolePermissions, roles, seasons } from "./schema/index.js";

const ROLE_NAMES: Record<RoleKey, string> = {
  super_admin: "Super Admin",
  league_admin: "League Administrator",
  head_coach: "Head Coach",
  assistant_coach: "Assistant Coach",
  team_manager: "Team Mom / Manager",
  scorekeeper: "Scorekeeper",
  parent: "Parent / Guardian",
};

/** One flag per release capability; all off until that release is accepted. */
export const FEATURE_FLAGS: { key: string; description: string }[] = [
  { key: "r1b.registration", description: "R1b: registration and Square checkout" },
  { key: "r2.waitlist_offers", description: "R2: automatic timed waitlist offers" },
  { key: "r2.refunds", description: "R2: in-app refunds" },
  { key: "r2.promo_codes", description: "R2: promo codes" },
  { key: "r2.staff_applications", description: "R2: coach / team manager applications and fees" },
  { key: "r3.teams_draft", description: "R3: teams, offline draft, rosters" },
  { key: "r3.practices", description: "R3: venues, fields and practices" },
  { key: "r4.games", description: "R4: game schedule, results and standings" },
  { key: "r4.announcements", description: "R4: announcements and targeted email" },
  { key: "r4.sms", description: "R4: Twilio SMS (needs A2P approval)" },
  { key: "r4.tixflo_widget", description: "R4: TixFlo ticket widget" },
  { key: "r5.playoffs", description: "R5: playoffs and brackets" },
  { key: "auth.google", description: "Backlog: Sign in with Google" },
  { key: "auth.microsoft", description: "Backlog: Sign in with Microsoft" },
];

export async function seedPlatform(conn: DbOrTx = db) {
  await conn
    .insert(permissions)
    .values(PERMISSIONS.map((key) => ({ key })))
    .onConflictDoNothing();

  // Two-step sign-in is optional for every role by default (decision Oct 30).
  // An admin can later require an authenticator app for a role by setting
  // roles.requires_totp = true; re-seeding never overwrites that choice.
  await conn
    .insert(roles)
    .values(ROLE_KEYS.map((key) => ({ key, name: ROLE_NAMES[key], requiresTotp: false })))
    .onConflictDoUpdate({ target: roles.key, set: { name: sql`excluded.name` } });

  const grants = ROLE_KEYS.flatMap((roleKey) =>
    DEFAULT_ROLE_PERMISSIONS[roleKey].map((permissionKey) => ({ roleKey, permissionKey })),
  );
  if (grants.length) await conn.insert(rolePermissions).values(grants).onConflictDoNothing();

  await conn.insert(featureFlags).values(FEATURE_FLAGS).onConflictDoNothing();
  await seedContent(conn);
  await seedPaymentSettings(conn);
}

/** Placeholder data so dev/staging screens have something to show. Not for prod. */
export async function seedSample(conn: DbOrTx = db) {
  const existing = await conn.select({ id: seasons.id }).from(seasons).limit(1);
  if (existing.length) return;
  const [season] = await conn
    .insert(seasons)
    .values({
      name: "2027 Spring Season (sample)",
      year: 2027,
      status: "planning",
      isCurrent: "current",
      registrationOpensAt: new Date("2026-12-01T13:00:00Z"),
    })
    .returning();
  if (!season) throw new Error("season insert failed");
  await conn.insert(divisions).values([
    { seasonId: season.id, name: "Sample Division A", capacity: 60, priceCents: 10000, sortOrder: 1 },
    { seasonId: season.id, name: "Sample Division B", capacity: 60, priceCents: 10000, sortOrder: 2 },
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const withSample = process.argv.includes("--sample");
  (async () => {
    await seedPlatform();
    if (withSample) await seedSample();
    console.log(`Seed complete${withSample ? " (with sample season)" : ""}`);
  })()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
