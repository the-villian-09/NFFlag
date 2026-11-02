/**
 * One place where modules attach outbox subscribers. Later releases add
 * lines here (e.g. game.rescheduled → SMS) without touching the code that
 * publishes the event. Handlers must be idempotent (delivery is at-least-once).
 */
import { and, eq, isNull } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { divisions, householdMembers, payments, players, registrations, seasons, user, userRoleAssignments, waitlistEntries } from "../db/schema/index.js";
import { positionOf } from "./registration/waitlist.js";
import { feeLabel, ROLE_LABELS, type VolunteerRole } from "./staff/service.js";
import { announcements, households, rosterEntries, teams, teamStaff, volunteerApplications, withdrawalRequests } from "../db/schema/index.js";
import { getSetting } from "./content/routes.js";
import { getEmailSender } from "../lib/email.js";
import { templates } from "../lib/email-templates.js";
import { logger } from "../lib/logger.js";
import { publish, subscribe } from "./platform/outbox.js";
import { divisions as divisionsTable, gameOfficials, games, refereeApplications, refereePayouts } from "../db/schema/index.js";
import { inArray } from "drizzle-orm";

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

async function waitlistContext(entryId: string) {
  const [e] = await db
    .select({
      id: waitlistEntries.id,
      householdId: waitlistEntries.householdId,
      divisionId: waitlistEntries.divisionId,
      createdAt: waitlistEntries.createdAt,
      status: waitlistEntries.status,
      offerExpiresAt: waitlistEntries.offerExpiresAt,
      player: players.firstName,
      playerLast: players.lastName,
      division: divisions.name,
    })
    .from(waitlistEntries)
    .innerJoin(players, eq(players.id, waitlistEntries.playerId))
    .innerJoin(divisions, eq(divisions.id, waitlistEntries.divisionId))
    .where(eq(waitlistEntries.id, entryId));
  if (!e) return null;
  const guardians = await db
    .select({ email: user.email })
    .from(householdMembers)
    .innerJoin(user, eq(user.id, householdMembers.userId))
    .where(eq(householdMembers.householdId, e.householdId));
  return { ...e, playerName: `${e.player} ${e.playerLast}`, emails: guardians.map((g) => g.email) };
}

const fmtDeadline = (d: Date) =>
  d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });

async function applicationContext(id: string) {
  const [a] = await db
    .select({ roleKey: volunteerApplications.roleKey, totalCents: volunteerApplications.totalCents, paidAt: volunteerApplications.paidAt, email: user.email, season: seasons.name })
    .from(volunteerApplications)
    .innerJoin(user, eq(user.id, volunteerApplications.userId))
    .innerJoin(seasons, eq(seasons.id, volunteerApplications.seasonId))
    .where(eq(volunteerApplications.id, id));
  return a ? { ...a, role: ROLE_LABELS[a.roleKey as VolunteerRole], fee: feeLabel(a.roleKey) } : null;
}

async function officialContext(id: string) {
  const [o] = await db
    .select({
      status: gameOfficials.status,
      rateCents: gameOfficials.rateCents,
      email: user.email,
      startsAt: games.startsAt,
      location: games.location,
      division: divisionsTable.name,
      homeTeamId: games.homeTeamId,
      awayTeamId: games.awayTeamId,
    })
    .from(gameOfficials)
    .innerJoin(user, eq(user.id, gameOfficials.userId))
    .innerJoin(games, eq(games.id, gameOfficials.gameId))
    .innerJoin(divisionsTable, eq(divisionsTable.id, games.divisionId))
    .where(eq(gameOfficials.id, id));
  if (!o) return null;
  const ts = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, [o.homeTeamId, o.awayTeamId]));
  const name = (tid: string) => ts.find((t) => t.id === tid)?.name ?? "TBD";
  return { ...o, matchup: `${name(o.homeTeamId)} vs ${name(o.awayTeamId)}`, when: fmtDeadline(o.startsAt) };
}

export function registerSubscribers() {
  /* ---------------- referees (R5) ---------------- */
  subscribe("referee.application_submitted", async (e) => {
    const [a] = await db
      .select({ name: user.name })
      .from(refereeApplications)
      .innerJoin(user, eq(user.id, refereeApplications.userId))
      .where(eq(refereeApplications.id, e.aggregateId));
    if (!a) return;
    const contact = await getSetting("contact");
    if (contact.inboxEmail) await getEmailSender().send(templates.refereeSignupLeague(contact.inboxEmail, { name: a.name, adminUrl: `${base()}/admin/referees` }));
    else logger.warn({ applicationId: e.aggregateId }, "referee sign-up saved; no inbox email set in Site content");
  });

  subscribe("referee.application_decided", async (e) => {
    const [a] = await db
      .select({ email: user.email, season: seasons.name })
      .from(refereeApplications)
      .innerJoin(user, eq(user.id, refereeApplications.userId))
      .innerJoin(seasons, eq(seasons.id, refereeApplications.seasonId))
      .where(eq(refereeApplications.id, e.aggregateId));
    if (!a) return;
    const p = e.payload as { decision: "approved" | "rejected" | "revoked"; reason?: string | null };
    await getEmailSender().send(templates.refereeDecision(a.email, { decision: p.decision, season: a.season, reason: p.reason ?? null, url: `${base()}/referees` }));
  });

  subscribe("referee.assigned", async (e) => {
    const o = await officialContext(e.aggregateId);
    if (!o || o.status !== "assigned") return; // removed since
    await getEmailSender().send(
      templates.refereeAssigned(o.email, { matchup: o.matchup, when: o.when, where: o.location, division: o.division, pay: money(o.rateCents), url: `${base()}/referees` }),
    );
  });

  subscribe("referee.unassigned", async (e) => {
    const o = await officialContext(e.aggregateId);
    if (!o || o.status !== "removed") return; // put back since
    await getEmailSender().send(templates.refereeUnassigned(o.email, { matchup: o.matchup, when: o.when, url: `${base()}/referees` }));
  });

  subscribe("referee.game_changed", async (e) => {
    const o = await officialContext(e.aggregateId);
    if (!o || o.status !== "assigned") return;
    const p = e.payload as { subject: string; body: string };
    await getEmailSender().send(templates.refereeGameChanged(o.email, { subject: p.subject, body: p.body, url: `${base()}/referees` }));
  });

  subscribe("referee.paid", async (e) => {
    const [p] = await db
      .select({ amountCents: refereePayouts.amountCents, email: user.email })
      .from(refereePayouts)
      .innerJoin(user, eq(user.id, refereePayouts.userId))
      .where(eq(refereePayouts.id, e.aggregateId));
    if (!p) return;
    const items = await db
      .select({ startsAt: games.startsAt, homeTeamId: games.homeTeamId, awayTeamId: games.awayTeamId, rateCents: gameOfficials.rateCents })
      .from(gameOfficials)
      .innerJoin(games, eq(games.id, gameOfficials.gameId))
      .where(eq(gameOfficials.payoutId, e.aggregateId));
    const ts = items.length
      ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, items.flatMap((i) => [i.homeTeamId, i.awayTeamId])))
      : [];
    const name = (tid: string) => ts.find((t) => t.id === tid)?.name ?? "TBD";
    const lines: [string, string][] = items
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((i) => [`${i.startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}: ${name(i.homeTeamId)} vs ${name(i.awayTeamId)}`, money(i.rateCents)]);
    await getEmailSender().send(templates.refereePaid(p.email, { amount: money(p.amountCents), games: lines, url: `${base()}/referees` }));
  });

  // Fan out: one event per guardian, so a failed send retries only that email.
  subscribe("roster.published", async (e) => {
    const [r] = await db
      .select({ householdId: players.householdId })
      .from(rosterEntries)
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .where(eq(rosterEntries.id, e.aggregateId));
    if (!r) return; // removed since
    const guardians = await db.select({ userId: householdMembers.userId }).from(householdMembers).where(eq(householdMembers.householdId, r.householdId));
    for (const g of guardians) {
      await publish(db, {
        name: "roster.notify",
        aggregateType: "roster_entry",
        aggregateId: e.aggregateId,
        payload: { userId: g.userId },
        dedupeKey: `roster.notify:${e.id}:${g.userId}`,
      });
    }
  });

  subscribe("announcement.sent", async (e) => {
    const { userId } = e.payload as { userId: string };
    const [a] = await db
      .select({
        subject: announcements.subject,
        body: announcements.body,
        audience: announcements.audience,
        team: teams.name,
        division: divisions.name,
        senderName: user.name,
        senderEmail: user.email,
      })
      .from(announcements)
      .leftJoin(teams, eq(teams.id, announcements.teamId))
      .leftJoin(divisions, eq(divisions.id, announcements.divisionId))
      .leftJoin(user, eq(user.id, announcements.sentBy))
      .where(eq(announcements.id, e.aggregateId));
    const [to] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
    if (!a || !to) return;
    const from = a.audience === "team" && a.team ? a.team : a.audience === "division" && a.division ? `NFFL ${a.division}` : "NFFL";
    await getEmailSender().send(
      templates.announcement(to.email, {
        from,
        subject: a.subject,
        body: a.body,
        senderName: a.senderName,
        replyTo: a.senderEmail,
        dashboardUrl: `${base()}/dashboard`,
      }),
    );
  });

  subscribe("roster.notify", async (e) => {
    const { userId } = e.payload as { userId: string };
    const [r] = await db
      .select({
        teamId: rosterEntries.teamId,
        team: teams.name,
        division: divisions.name,
        player: players.firstName,
        playerLast: players.lastName,
        householdId: players.householdId,
      })
      .from(rosterEntries)
      .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
      .innerJoin(divisions, eq(divisions.id, teams.divisionId))
      .innerJoin(players, eq(players.id, rosterEntries.playerId))
      .where(eq(rosterEntries.id, e.aggregateId));
    if (!r) return;
    const [g] = await db
      .select({ email: user.email })
      .from(householdMembers)
      .innerJoin(user, eq(user.id, householdMembers.userId))
      .where(and(eq(householdMembers.householdId, r.householdId), eq(householdMembers.userId, userId)));
    if (!g) return; // no longer in the household
    const [coach] = await db
      .select({ name: user.name, email: user.email })
      .from(teamStaff)
      .innerJoin(user, eq(user.id, teamStaff.userId))
      .where(and(eq(teamStaff.teamId, r.teamId), eq(teamStaff.roleKey, "head_coach")));
    await getEmailSender().send(
      templates.rosterPublished(g.email, {
        player: `${r.player} ${r.playerLast}`,
        team: r.team,
        division: r.division,
        coach: coach?.name ?? null,
        coachEmail: coach?.email ?? null,
        dashboardUrl: `${base()}/dashboard`,
      }),
    );
  });

  subscribe("staff.application_submitted", async (e) => {
    const a = await applicationContext(e.aggregateId);
    if (!a) return;
    await getEmailSender().send(
      templates.volunteerSubmitted(a.email, { role: a.role, season: a.season, amount: a.paidAt ? money(a.totalCents) : null, fee: a.fee, accountUrl: `${base()}/coaches-staff` }),
    );
  });

  subscribe("staff.application_decided", async (e) => {
    const a = await applicationContext(e.aggregateId);
    if (!a) return;
    const p = e.payload as { decision?: string; reason?: string | null };
    await getEmailSender().send(
      templates.volunteerDecision(a.email, { role: a.role, season: a.season, approved: p.decision === "approved", reason: p.reason ?? null, accountUrl: `${base()}/coaches-staff` }),
    );
  });

  subscribe("staff.application_refunded", async (e) => {
    const a = await applicationContext(e.aggregateId);
    if (!a) return;
    await getEmailSender().send(templates.volunteerRefunded(a.email, { amount: money((e.payload as { amountCents?: number }).amountCents ?? 0), fee: a.fee }));
  });

  subscribe("waitlist.joined", async (e) => {
    const c = await waitlistContext(e.aggregateId);
    if (!c || c.status !== "waiting") return;
    const position = (await positionOf(c)) + 1;
    for (const to of c.emails) {
      await getEmailSender().send(templates.waitlistJoined(to, { player: c.playerName, division: c.division, position, dashboardUrl: `${base()}/dashboard` }));
    }
  });

  subscribe("waitlist.offered", async (e) => {
    const c = await waitlistContext(e.aggregateId);
    if (!c || c.status !== "offered" || !c.offerExpiresAt) return;
    for (const to of c.emails) {
      await getEmailSender().send(
        templates.waitlistOffered(to, {
          player: c.playerName,
          division: c.division,
          deadline: fmtDeadline(c.offerExpiresAt),
          claimUrl: `${base()}/register?offer=${c.id}`,
        }),
      );
    }
  });

  subscribe("waitlist.offer_expired", async (e) => {
    const c = await waitlistContext(e.aggregateId);
    if (!c || c.status !== "expired") return;
    for (const to of c.emails) {
      await getEmailSender().send(templates.waitlistExpired(to, { player: c.playerName, division: c.division, dashboardUrl: `${base()}/dashboard` }));
    }
  });

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

  subscribe("registration.cancelled", async (e) => {
    const c = await registrationContext(e.aggregateId);
    if (!c) return;
    for (const to of c.emails) await getEmailSender().send(templates.registrationCancelled(to, { player: c.playerName, division: c.division, dashboardUrl: `${base()}/dashboard` }));
  });

  subscribe("registration.withdrawal_requested", async (e) => {
    const [w] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, e.aggregateId));
    if (!w) return;
    const c = await registrationContext(w.registrationId);
    if (!c) return;
    const [h] = await db.select({ name: households.displayName }).from(households).where(eq(households.id, c.householdId));
    const contact = await getSetting("contact");
    if (contact.inboxEmail) {
      await getEmailSender().send(
        templates.withdrawalRequestedLeague(contact.inboxEmail, {
          player: c.playerName,
          division: c.division,
          family: h?.name ?? "A family",
          reason: w.reason,
          adminUrl: `${base()}/admin/registrations/${w.registrationId}`,
        }),
      );
    } else logger.warn({ requestId: w.id }, "withdrawal request saved; no inbox email set in Site content");
    for (const to of c.emails) await getEmailSender().send(templates.withdrawalRequestedFamily(to, { player: c.playerName, dashboardUrl: `${base()}/dashboard` }));
  });

  subscribe("registration.withdrawal_declined", async (e) => {
    const [w] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, e.aggregateId));
    if (!w) return;
    const c = await registrationContext(w.registrationId);
    if (!c) return;
    for (const to of c.emails) await getEmailSender().send(templates.withdrawalDeclined(to, { player: c.playerName, note: w.adminNote ?? "", dashboardUrl: `${base()}/dashboard` }));
  });

  subscribe("registration.refunded", async (e) => {
    const c = await registrationContext(e.aggregateId);
    if (!c) return;
    const amount = (e.payload as { amountCents?: number }).amountCents ?? 0;
    for (const to of c.emails) {
      await getEmailSender().send(templates.registrationRefunded(to, { player: c.playerName, amount: money(amount), dashboardUrl: `${base()}/dashboard` }));
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
