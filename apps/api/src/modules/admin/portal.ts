/**
 * Admin portal helpers:
 *   GET /api/v1/admin/summary   → "Needs attention" counts, only for what the admin may see
 *   GET /api/v1/admin/search?q= → people (players, families, coaches, referees) by name or email
 */
import type { Permission } from "@nffl/shared";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  divisions,
  gameOfficials,
  games,
  householdMembers,
  households,
  players,
  refereeApplications,
  refereePayouts,
  registrations,
  seasons,
  user,
  volunteerApplications,
  withdrawalRequests,
} from "../../db/schema/index.js";
import { adminIdleTimeout, handler, requireAuth, requireMfa } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";
import { checkoutConfig } from "../payments/gateway.js";
import { isEnabled } from "../platform/flags.js";
import { ROLE_LABELS, type VolunteerRole } from "../staff/service.js";

export const adminPortalRouter = Router();
adminPortalRouter.use(requireAuth, requireMfa, adminIdleTimeout);

const may = (req: Request, p: Permission) => !!req.ctx.access?.leagueWide.has(p);
const isPortalUser = (req: Request) => !!req.ctx.access && req.ctx.access.leagueWide.size > 0;

async function currentSeasonId() {
  const [s] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s?.id ?? null;
}

const count = (rows: { n: number }[]) => rows[0]?.n ?? 0;
const n = sql<number>`count(*)::int`;

export interface Attention {
  key: string;
  count: number;
  /** Shown as dollars instead of a count. */
  cents?: number;
  label: string;
  href: string;
  tone: "warn" | "bad";
}

adminPortalRouter.get(
  "/summary",
  handler(async (req, res) => {
    if (!isPortalUser(req)) throw new HttpError(403, "FORBIDDEN", "Admins only.");
    const seasonId = await currentSeasonId();
    const items: Attention[] = [];
    const add = (a: Attention) => {
      if (a.count > 0 || (a.cents ?? 0) > 0) items.push(a);
    };
    const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);

    if (may(req, "payments.read") && (await isEnabled("r1b.registration")) && !(await checkoutConfig())) {
      add({ key: "payments_down", count: 1, label: "Online payments are unavailable: check the payment provider", href: "/admin/payments", tone: "bad" });
    }
    if (seasonId && may(req, "registrations.read")) {
      const k = count(await db.select({ n }).from(registrations).where(and(eq(registrations.seasonId, seasonId), eq(registrations.status, "paid"))));
      add({ key: "registrations", count: k, label: plural(k, "registration to review", "registrations to review"), href: "/admin/registrations", tone: "warn" });
    }
    if (may(req, "registrations.read")) {
      const k = count(await db.select({ n }).from(withdrawalRequests).where(eq(withdrawalRequests.status, "open")));
      add({ key: "withdrawals", count: k, label: plural(k, "withdrawal request", "withdrawal requests"), href: "/admin/registrations?show=withdrawal", tone: "warn" });
    }
    if (seasonId && may(req, "staff.applications.review")) {
      const k = count(await db.select({ n }).from(volunteerApplications).where(and(eq(volunteerApplications.seasonId, seasonId), eq(volunteerApplications.status, "submitted"))));
      add({ key: "staff", count: k, label: plural(k, "coach application to review", "coach applications to review"), href: "/admin/staff", tone: "warn" });
    }
    if (seasonId && may(req, "referees.manage")) {
      const k = count(await db.select({ n }).from(refereeApplications).where(and(eq(refereeApplications.seasonId, seasonId), eq(refereeApplications.status, "submitted"))));
      add({ key: "referees", count: k, label: plural(k, "referee sign-up to review", "referee sign-ups to review"), href: "/admin/referees", tone: "warn" });
      if (await isEnabled("r5.referees")) {
        const active = sql<number>`(select count(*)::int from ${gameOfficials} where ${gameOfficials.gameId} = ${games.id} and ${gameOfficials.status} <> 'removed')`;
        const g = count(
          await db
            .select({ n })
            .from(games)
            .where(
              and(
                eq(games.seasonId, seasonId),
                eq(games.status, "scheduled"),
                gt(games.startsAt, new Date()),
                lt(games.startsAt, new Date(Date.now() + 7 * 86400_000)),
                sql`${active} < ${games.refereeSlots}`,
              ),
            ),
        );
        add({ key: "games_refs", count: g, label: plural(g, "game this week needs referees", "games this week need referees"), href: "/admin/referees/games", tone: "warn" });
      }
    }
    if (may(req, "referees.pay")) {
      const [owed] = await db
        .select({ cents: sql<number>`coalesce(sum(${gameOfficials.rateCents}), 0)::int`, k: n })
        .from(gameOfficials)
        .innerJoin(games, eq(games.id, gameOfficials.gameId))
        .where(and(inArray(gameOfficials.status, ["assigned", "worked"]), isNull(gameOfficials.payoutId), eq(games.status, "final"), gt(gameOfficials.rateCents, 0)));
      add({ key: "ref_pay", count: 0, cents: owed?.cents ?? 0, label: "referee pay owed for final games", href: "/admin/referees/pay", tone: "warn" });
      const failed = count(await db.select({ n }).from(refereePayouts).where(eq(refereePayouts.status, "failed")));
      add({ key: "ref_pay_failed", count: failed, label: plural(failed, "referee payment not sent", "referee payments not sent"), href: "/admin/referees/pay", tone: "bad" });
    }
    // Problems first.
    items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
    res.json({ items });
  }),
);

export interface SearchResult {
  type: "player" | "family" | "coach" | "referee";
  id: string;
  label: string;
  detail: string;
  href: string;
}

const REG_LABEL: Record<string, string> = {
  pending_payment: "Awaiting payment",
  processing: "Confirming payment",
  paid: "Needs review",
  approved: "Approved",
  rejected: "Not accepted",
  expired: "Expired",
  cancelled: "Cancelled",
};
const APP_LABEL: Record<string, string> = {
  pending_payment: "Awaiting fee",
  processing: "Confirming payment",
  submitted: "Needs review",
  approved: "Approved",
  rejected: "Not approved",
  withdrawn: "Withdrawn",
  revoked: "Approval removed",
};

adminPortalRouter.get(
  "/search",
  handler(async (req, res) => {
    if (!isPortalUser(req)) throw new HttpError(403, "FORBIDDEN", "Admins only.");
    const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(req.query);
    // Wildcards typed by the admin are matched literally.
    const esc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = `%${esc(q)}%`;
    const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
    const seasonId = await currentSeasonId();
    const out: SearchResult[] = [];

    if (may(req, "registrations.read")) {
      // Players: "first last" in either order, each word matching first or last name.
      const nameMatch = and(...words.map((w) => or(ilike(players.firstName, `%${esc(w)}%`), ilike(players.lastName, `%${esc(w)}%`))));
      const regs = await db
        .select({
          id: registrations.id,
          status: registrations.status,
          first: players.firstName,
          last: players.lastName,
          division: divisions.name,
          season: seasons.name,
          isCurrent: seasons.isCurrent,
        })
        .from(registrations)
        .innerJoin(players, eq(players.id, registrations.playerId))
        .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
        .innerJoin(seasons, eq(seasons.id, registrations.seasonId))
        .where(nameMatch)
        .orderBy(desc(seasons.isCurrent), desc(registrations.createdAt))
        .limit(8);
      for (const r of regs) {
        out.push({
          type: "player",
          id: r.id,
          label: `${r.first} ${r.last}`,
          detail: `${r.division} · ${REG_LABEL[r.status] ?? r.status}${r.isCurrent ? "" : ` · ${r.season}`}`,
          href: `/admin/registrations/${r.id}`,
        });
      }
      // Families: family name, or a parent's name or email.
      const fams = await db
        .selectDistinct({ id: households.id, name: households.displayName, phone: households.phone })
        .from(households)
        .leftJoin(householdMembers, eq(householdMembers.householdId, households.id))
        .leftJoin(user, eq(user.id, householdMembers.userId))
        .where(or(ilike(households.displayName, like), ilike(user.name, like), ilike(user.email, like)))
        .orderBy(asc(households.displayName))
        .limit(6);
      for (const f of fams) {
        out.push({ type: "family", id: f.id, label: f.name, detail: "Family · their registrations", href: `/admin/registrations?q=${encodeURIComponent(f.name)}` });
      }
    }
    if (may(req, "staff.applications.review")) {
      const apps = await db
        .select({ id: volunteerApplications.id, roleKey: volunteerApplications.roleKey, status: volunteerApplications.status, name: user.name, email: user.email })
        .from(volunteerApplications)
        .innerJoin(user, eq(user.id, volunteerApplications.userId))
        .where(and(or(ilike(user.name, like), ilike(user.email, like)), seasonId ? eq(volunteerApplications.seasonId, seasonId) : undefined, ne(volunteerApplications.status, "withdrawn")))
        .orderBy(asc(user.name))
        .limit(6);
      for (const a of apps) {
        out.push({ type: "coach", id: a.id, label: a.name, detail: `${ROLE_LABELS[a.roleKey as VolunteerRole] ?? a.roleKey} · ${APP_LABEL[a.status] ?? a.status}`, href: `/admin/staff/${a.id}` });
      }
    }
    if (may(req, "referees.manage")) {
      const refs = await db
        .select({ id: refereeApplications.id, status: refereeApplications.status, name: user.name })
        .from(refereeApplications)
        .innerJoin(user, eq(user.id, refereeApplications.userId))
        .where(and(or(ilike(user.name, like), ilike(user.email, like)), seasonId ? eq(refereeApplications.seasonId, seasonId) : undefined, ne(refereeApplications.status, "withdrawn")))
        .orderBy(asc(user.name))
        .limit(6);
      for (const r of refs) {
        out.push({ type: "referee", id: r.id, label: r.name, detail: `Referee · ${APP_LABEL[r.status] ?? r.status}`, href: `/admin/referees/${r.id}` });
      }
    }
    res.json({ items: out });
  }),
);
