/**
 * One place where modules attach outbox subscribers. Later releases add
 * lines here (e.g. game.rescheduled → SMS) without touching the code that
 * publishes the event. Handlers must be idempotent (delivery is at-least-once).
 */
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { divisions, householdMembers, payments, players, registrations, seasons, user, userRoleAssignments } from "../db/schema/index.js";
import { getEmailSender } from "../lib/email.js";
import { templates } from "../lib/email-templates.js";
import { logger } from "../lib/logger.js";
import { subscribe } from "./platform/outbox.js";

const base = () => env.APP_BASE_URL.replace(/\/$/, "");
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function registrationContext(registrationId: string) {
  const [r] = await db
    .select({
      householdId: registrations.householdId,
      totalCents: registrations.totalCents,
      decisionReason: registrations.decisionReason,
      player: players.firstName,
      playerLast: players.lastName,
      division: divisions.name,
      season: seasons.name,
    })
    .from(registrations)
    .innerJoin(players, eq(players.id, registrations.playerId))
    .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
    .innerJoin(seasons, eq(seasons.id, registrations.seasonId))
    .where(eq(registrations.id, registrationId));
  if (!r) return null;
  const guardians = await db
    .select({ email: user.email })
    .from(householdMembers)
    .innerJoin(user, eq(user.id, householdMembers.userId))
    .where(eq(householdMembers.householdId, r.householdId));
  return { ...r, playerName: `${r.player} ${r.playerLast}`, emails: guardians.map((g) => g.email) };
}

export function registerSubscribers() {
  subscribe("user.mfa_reset", async (e) => {
    logger.info({ userId: e.aggregateId }, "mfa reset recorded");
  });

  subscribe("registration.paid", async (e) => {
    const c = await registrationContext(e.aggregateId);
    if (!c) return;
    const [p] = await db.select({ receiptUrl: payments.receiptUrl, amount: payments.amountCents }).from(payments).where(eq(payments.registrationId, e.aggregateId));
    for (const to of c.emails) {
      await getEmailSender().send(
        templates.registrationPaid(to, {
          player: c.playerName,
          division: c.division,
          season: c.season,
          total: money(p?.amount ?? c.totalCents),
          receiptUrl: p?.receiptUrl ?? null,
          dashboardUrl: `${base()}/dashboard`,
        }),
      );
    }
  });

  subscribe("eligibility.decided", async (e) => {
    const c = await registrationContext(e.aggregateId);
    if (!c) return;
    const payload = e.payload as { decision?: string; reason?: string | null };
    for (const to of c.emails) {
      await getEmailSender().send(
        templates.registrationDecision(to, {
          player: c.playerName,
          division: c.division,
          approved: payload.decision === "approved",
          reason: payload.reason ?? null,
          dashboardUrl: `${base()}/dashboard`,
        }),
      );
    }
  });

  subscribe("registration.refunded", async (e) => {
    const c = await registrationContext(e.aggregateId);
    if (!c) return;
    const amount = (e.payload as { amountCents?: number }).amountCents ?? 0;
    for (const to of c.emails) {
      await getEmailSender().send(templates.registrationRefunded(to, { player: c.playerName, amount: money(amount) }));
    }
  });

  subscribe("square.disconnected", async (e) => {
    const p = e.payload as { by?: string | null; merchantName?: string | null; reason?: string | null };
    const admins = await db
      .select({ email: user.email })
      .from(userRoleAssignments)
      .innerJoin(user, eq(user.id, userRoleAssignments.userId))
      .where(and(eq(userRoleAssignments.roleKey, "super_admin"), isNull(userRoleAssignments.revokedAt)));
    for (const { email } of admins) {
      await getEmailSender().send(
        templates.squareDisconnected(email, {
          by: p.by ?? null,
          merchantName: p.merchantName ?? null,
          reason: p.reason ?? null,
          adminUrl: `${base()}/admin/payments`,
        }),
      );
    }
  });
}
