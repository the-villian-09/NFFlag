/**
 * Team spaces: feed posts, alerts, chat, read receipts, RSVPs and reports.
 * Every function takes a Space already checked by spaceFor() (membership.ts),
 * so a caller can never act on a team they don't belong to.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  games,
  householdMembers,
  players,
  practices,
  rosterEntries,
  teamChannelReads,
  teamMessageReads,
  teamMessageReports,
  teamMessages,
  teamPrefs,
  teamRsvps,
  teamStaff,
  teams,
  user,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { publish as queue } from "../platform/outbox.js";
import { broadcast, onlineUserIds } from "./live.js";
import { spacesFor, teamMembers, type Space } from "./membership.js";
import { pushTo } from "./push.js";

export type View = "feed" | "chat" | "staff";
const STAFF_LABEL: Record<string, string> = { head_coach: "Head coach", assistant_coach: "Assistant coach", team_manager: "Team mom" };
const first = (p: { firstName: string; preferredName: string | null }) => p.preferredName || p.firstName;

function viewWhere(teamId: string, view: View) {
  const base = and(eq(teamMessages.teamId, teamId), isNull(teamMessages.deletedAt));
  if (view === "staff") return and(base, eq(teamMessages.channel, "staff"));
  if (view === "chat") return and(base, eq(teamMessages.channel, "team"), eq(teamMessages.kind, "chat"));
  return and(base, eq(teamMessages.channel, "team"), inArray(teamMessages.kind, ["post", "alert"]));
}

function canSee(space: Space, view: View) {
  return view !== "staff" || space.role === "staff" || space.role === "admin";
}

/* ---------------- labels: "Head coach", "Parent of Marcus" ---------------- */

async function authorLabels(teamId: string, userIds: string[]) {
  const out = new Map<string, { name: string; label: string }>();
  if (!userIds.length) return out;
  const names = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds));
  const staff = await db.select({ userId: teamStaff.userId, roleKey: teamStaff.roleKey }).from(teamStaff).where(and(eq(teamStaff.teamId, teamId), inArray(teamStaff.userId, userIds)));
  const kids = await db
    .select({ userId: householdMembers.userId, firstName: players.firstName, preferredName: players.preferredName })
    .from(householdMembers)
    .innerJoin(players, eq(players.householdId, householdMembers.householdId))
    .innerJoin(rosterEntries, and(eq(rosterEntries.playerId, players.id), eq(rosterEntries.teamId, teamId)))
    .where(inArray(householdMembers.userId, userIds));
  for (const n of names) {
    const s = staff.find((x) => x.userId === n.id);
    const k = kids.filter((x) => x.userId === n.id).map(first);
    out.set(n.id, { name: n.name, label: s ? (STAFF_LABEL[s.roleKey] ?? "Coach") : k.length ? `Parent of ${k.join(" & ")}` : "League" });
  }
  return out;
}

type Row = typeof teamMessages.$inferSelect;

/** Messages as the screens show them (same shape for lists and live events). */
export async function present(teamId: string, rows: Row[]) {
  if (!rows.length) return [];
  const labels = await authorLabels(teamId, [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))]);
  const ids = rows.filter((r) => r.kind !== "chat").map((r) => r.id);
  const seen = ids.length
    ? await db.select({ messageId: teamMessageReads.messageId, n: sql<number>`count(*)::int` }).from(teamMessageReads).where(inArray(teamMessageReads.messageId, ids)).groupBy(teamMessageReads.messageId)
    : [];
  const seenBy = new Map(seen.map((s) => [s.messageId, s.n]));
  return rows.map((r) => {
    const a = r.authorUserId ? labels.get(r.authorUserId) : null;
    return {
      id: r.id,
      teamId: r.teamId,
      channel: r.channel,
      kind: r.kind,
      body: r.body,
      pinned: r.pinned,
      eventType: r.eventType,
      eventId: r.eventId,
      createdAt: r.createdAt,
      authorUserId: r.authorUserId,
      authorName: a?.name ?? "Former member",
      authorLabel: a?.label ?? "",
      seenCount: r.kind === "chat" ? null : (seenBy.get(r.id) ?? 0),
    };
  });
}

/** For live events: the message as the screens show it. */
export async function presentById(id: string) {
  const [r] = await db.select().from(teamMessages).where(eq(teamMessages.id, id));
  if (!r) return null;
  return (await present(r.teamId, [r]))[0] ?? null;
}

/* ---------------- My teams ---------------- */

async function lastReads(userId: string, teamIds: string[]) {
  if (!teamIds.length) return new Map<string, Date>();
  const rows = await db.select().from(teamChannelReads).where(and(eq(teamChannelReads.userId, userId), inArray(teamChannelReads.teamId, teamIds)));
  return new Map(rows.map((r) => [`${r.teamId}:${r.view}`, r.lastReadAt]));
}

async function unread(userId: string, teamId: string, view: View, since: Date | undefined) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teamMessages)
    .where(and(viewWhere(teamId, view), since ? gt(teamMessages.createdAt, since) : undefined, or(isNull(teamMessages.authorUserId), ne(teamMessages.authorUserId, userId))));
  return r?.n ?? 0;
}

/** Upcoming games and practices for a team (yesterday onward, next 45 days). */
async function upcoming(teamId: string, days = 45) {
  const from = new Date(Date.now() - 24 * 3600_000);
  const to = new Date(Date.now() + days * 24 * 3600_000);
  const g = await db
    .select({ id: games.id, startsAt: games.startsAt, location: games.location, status: games.status, homeTeamId: games.homeTeamId, awayTeamId: games.awayTeamId })
    .from(games)
    .where(and(or(eq(games.homeTeamId, teamId), eq(games.awayTeamId, teamId)), gte(games.startsAt, from), lte(games.startsAt, to), inArray(games.status, ["scheduled", "postponed"])));
  const opp = g.length ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, g.map((x) => (x.homeTeamId === teamId ? x.awayTeamId : x.homeTeamId)))) : [];
  const p = await db
    .select({ id: practices.id, startsAt: practices.startsAt, location: practices.location, durationMinutes: practices.durationMinutes, notes: practices.notes })
    .from(practices)
    .where(and(eq(practices.teamId, teamId), eq(practices.status, "scheduled"), gte(practices.startsAt, from), lte(practices.startsAt, to)));
  return [
    ...g.map((x) => {
      const o = opp.find((t) => t.id === (x.homeTeamId === teamId ? x.awayTeamId : x.homeTeamId));
      return { type: "game" as const, id: x.id, startsAt: x.startsAt, location: x.location, title: `${x.homeTeamId === teamId ? "vs" : "at"} ${o?.name ?? "TBD"}`, status: x.status };
    }),
    ...p.map((x) => ({ type: "practice" as const, id: x.id, startsAt: x.startsAt, location: x.location, title: "Practice", status: "scheduled", durationMinutes: x.durationMinutes, notes: x.notes })),
  ].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

async function rsvpsFor(eventKeys: { type: string; id: string }[], playerIds?: string[]) {
  if (!eventKeys.length) return [];
  return db
    .select()
    .from(teamRsvps)
    .where(and(inArray(teamRsvps.eventId, eventKeys.map((e) => e.id)), playerIds ? (playerIds.length ? inArray(teamRsvps.playerId, playerIds) : sql`false`) : undefined));
}

async function childNames(playerIds: string[]) {
  if (!playerIds.length) return new Map<string, string>();
  const rows = await db.select({ id: players.id, firstName: players.firstName, preferredName: players.preferredName }).from(players).where(inArray(players.id, playerIds));
  return new Map(rows.map((r) => [r.id, first(r)]));
}

export async function mySpaces(userId: string) {
  const spaces = await spacesFor(userId);
  const ids = spaces.map((s) => s.teamId);
  const reads = await lastReads(userId, ids);
  const muted = ids.length ? await db.select().from(teamPrefs).where(and(eq(teamPrefs.userId, userId), inArray(teamPrefs.teamId, ids))) : [];
  const names = await childNames(spaces.flatMap((s) => s.playerIds));
  const out = [];
  for (const s of spaces) {
    const [latest] = await db.select().from(teamMessages).where(and(eq(teamMessages.teamId, s.teamId), eq(teamMessages.channel, "team"), isNull(teamMessages.deletedAt))).orderBy(desc(teamMessages.createdAt)).limit(1);
    const [alert] = await db
      .select()
      .from(teamMessages)
      .where(and(viewWhere(s.teamId, "feed"), eq(teamMessages.pinned, true)))
      .orderBy(desc(teamMessages.createdAt))
      .limit(1);
    const next = s.readOnly ? null : ((await upcoming(s.teamId, 14))[0] ?? null);
    const mine = next ? await rsvpsFor([next], s.playerIds) : [];
    out.push({
      ...s,
      children: s.playerIds.map((id) => ({ playerId: id, name: names.get(id) ?? "" })),
      muted: muted.some((m) => m.teamId === s.teamId && m.muted),
      unread: {
        feed: await unread(userId, s.teamId, "feed", reads.get(`${s.teamId}:feed`)),
        chat: await unread(userId, s.teamId, "chat", reads.get(`${s.teamId}:chat`)),
        staff: s.role === "staff" ? await unread(userId, s.teamId, "staff", reads.get(`${s.teamId}:staff`)) : 0,
      },
      latest: latest ? (await present(s.teamId, [latest]))[0] : null,
      pinned: alert ? (await present(s.teamId, [alert]))[0] : null,
      next: next ? { ...next, myRsvps: s.playerIds.map((pid) => ({ playerId: pid, name: names.get(pid) ?? "", status: mine.find((r) => r.playerId === pid && r.eventId === next.id)?.status ?? null })) } : null,
    });
  }
  return out;
}

/* ---------------- one team ---------------- */

export async function spaceDetail(space: Space) {
  const members = await teamMembers(space.teamId);
  const labels = await authorLabels(space.teamId, members.map((m) => m.userId));
  const names = await childNames(space.playerIds);
  return {
    team: { id: space.teamId, name: space.teamName, color: space.color, divisionName: space.divisionName, seasonName: space.seasonName },
    role: space.role,
    staffRole: space.staffRole,
    readOnly: space.readOnly,
    children: space.playerIds.map((id) => ({ playerId: id, name: names.get(id) ?? "" })),
    can: {
      chat: !space.readOnly && space.role !== "admin",
      post: !space.readOnly && space.role === "staff",
      staffChannel: space.role === "staff" || space.role === "admin",
      moderate: space.role === "admin" || (space.role === "staff" && space.staffRole !== null),
      seeRsvps: space.role === "staff" || space.role === "admin",
    },
    members: members
      .map((m) => ({ role: m.role, ...(labels.get(m.userId) ?? { name: "", label: "" }) }))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "staff" ? -1 : 1)),
    counts: { families: members.filter((m) => m.role === "family").length, staff: members.filter((m) => m.role === "staff").length },
  };
}

export async function listMessages(space: Space, view: View, before?: string, limit = 50) {
  if (!canSee(space, view)) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom can see the staff chat.");
  const cursor = before ? new Date(before) : null;
  const rows = await db
    .select()
    .from(teamMessages)
    .where(and(viewWhere(space.teamId, view), cursor && !Number.isNaN(cursor.getTime()) ? lt(teamMessages.createdAt, cursor) : undefined))
    .orderBy(desc(teamMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  const items = await present(space.teamId, rows.reverse());
  const total = (await teamMembers(space.teamId)).length;
  return { items, members: total, more: rows.length === limit };
}

/** Light flood control: 20 messages a minute per person. */
async function checkRate(userId: string) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teamMessages)
    .where(and(eq(teamMessages.authorUserId, userId), gt(teamMessages.createdAt, new Date(Date.now() - 60_000))));
  if ((r?.n ?? 0) >= 20) throw new HttpError(429, "RATE_LIMITED", "You're sending messages very fast. Wait a moment and try again.");
}

async function eventOfTeam(teamId: string, type: string, id: string) {
  if (type === "game") {
    const [g] = await db.select({ id: games.id, startsAt: games.startsAt }).from(games).where(and(eq(games.id, id), or(eq(games.homeTeamId, teamId), eq(games.awayTeamId, teamId))));
    return g ? { ...g, label: "Game" } : null;
  }
  const [p] = await db.select({ id: practices.id, startsAt: practices.startsAt }).from(practices).where(and(eq(practices.id, id), eq(practices.teamId, teamId)));
  return p ? { ...p, label: "Practice" } : null;
}

export async function postMessage(
  userId: string,
  space: Space,
  input: { view: View; body: string; alert?: boolean; pin?: boolean; eventType?: "game" | "practice"; eventId?: string },
) {
  if (space.readOnly) throw new HttpError(409, "CONFLICT", "This season has ended; the team space is read-only.");
  if (space.role === "admin") throw new HttpError(403, "FORBIDDEN", "League admins can read and moderate but not post here.");
  if (!canSee(space, input.view)) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom can post in the staff chat.");
  const staff = space.role === "staff";
  if (input.view === "feed" && !staff) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom post updates. Use the team chat instead.");
  if ((input.alert || input.pin || input.eventId) && !staff) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom can send alerts.");
  if (input.eventId && !(input.eventType && (await eventOfTeam(space.teamId, input.eventType, input.eventId)))) throw new HttpError(400, "VALIDATION_FAILED", "Pick one of this team's games or practices.");
  await checkRate(userId);

  const kind = input.view === "feed" ? (input.alert ? "alert" : "post") : "chat";
  const [row] = await db
    .insert(teamMessages)
    .values({
      teamId: space.teamId,
      authorUserId: userId,
      channel: input.view === "staff" ? "staff" : "team",
      kind,
      body: input.body,
      pinned: kind !== "chat" && (!!input.pin || kind === "alert"),
      eventType: input.eventId ? input.eventType! : null,
      eventId: input.eventId ?? null,
    })
    .returning();
  // An alert replaces the previous pinned alert.
  if (row!.pinned) {
    await db.update(teamMessages).set({ pinned: false }).where(and(eq(teamMessages.teamId, space.teamId), eq(teamMessages.pinned, true), ne(teamMessages.id, row!.id)));
  }
  await db.insert(teamMessageReads).values({ messageId: row!.id, userId }).onConflictDoNothing();
  await broadcast({ teamId: space.teamId, channel: row!.channel, type: "message", id: row!.id });

  // Pushes (and emails for alerts) go to everyone else in the channel.
  const members = (await teamMembers(space.teamId)).filter((m) => m.userId !== userId && (row!.channel === "team" || m.role === "staff"));
  const [author] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
  const title = row!.channel === "staff" ? `${space.teamName} staff` : space.teamName;
  const url = `/team/${space.teamId}${kind === "chat" ? (row!.channel === "staff" ? "?view=staff" : "?view=chat") : ""}`;
  const online = onlineUserIds();
  const recipients = kind === "chat" ? members.filter((m) => !online.has(m.userId)) : members;
  void pushTo(
    recipients.map((m) => m.userId),
    space.teamId,
    { title: kind === "alert" ? `${title}: ${input.body.split("\n")[0]!.slice(0, 80)}` : title, body: kind === "alert" ? input.body : `${author?.name ?? "Someone"}: ${input.body}`, url, tag: kind === "alert" ? `alert-${space.teamId}` : undefined },
    { urgent: kind === "alert" },
  );
  if (kind === "alert") {
    for (const m of members) {
      await queue(db, { name: "team.alert", aggregateType: "team_message", aggregateId: row!.id, payload: { userId: m.userId }, dedupeKey: `team.alert:${row!.id}:${m.userId}` });
    }
  }
  return (await present(space.teamId, [row!]))[0];
}

async function messageInSpace(space: Space, messageId: string) {
  const [m] = await db.select().from(teamMessages).where(and(eq(teamMessages.id, messageId), eq(teamMessages.teamId, space.teamId)));
  if (!m || m.deletedAt) throw new HttpError(404, "NOT_FOUND", "Message not found.");
  if (!canSee(space, m.channel === "staff" ? "staff" : "chat")) throw new HttpError(404, "NOT_FOUND", "Message not found.");
  return m;
}

export async function deleteMessage(userId: string, space: Space, messageId: string) {
  const m = await messageInSpace(space, messageId);
  const mod = space.role === "admin" || space.role === "staff";
  if (m.authorUserId !== userId && !mod) throw new HttpError(403, "FORBIDDEN", "You can only remove your own messages.");
  await db.update(teamMessages).set({ deletedAt: new Date(), deletedBy: userId, pinned: false }).where(eq(teamMessages.id, m.id));
  await broadcast({ teamId: space.teamId, channel: m.channel, type: "delete", id: m.id });
}

export async function setPinned(space: Space, messageId: string, pinned: boolean) {
  if (space.role !== "staff" || space.readOnly) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom can pin posts.");
  const m = await messageInSpace(space, messageId);
  if (m.kind === "chat") throw new HttpError(400, "VALIDATION_FAILED", "Only feed posts can be pinned.");
  if (pinned) await db.update(teamMessages).set({ pinned: false }).where(and(eq(teamMessages.teamId, space.teamId), eq(teamMessages.pinned, true)));
  await db.update(teamMessages).set({ pinned }).where(eq(teamMessages.id, m.id));
  await broadcast({ teamId: space.teamId, channel: "team", type: "pin", id: m.id });
}

export async function markRead(userId: string, space: Space, view: View) {
  if (space.role === "admin" || !canSee(space, view)) return;
  await db
    .insert(teamChannelReads)
    .values({ teamId: space.teamId, userId, view, lastReadAt: new Date() })
    .onConflictDoUpdate({ target: [teamChannelReads.teamId, teamChannelReads.userId, teamChannelReads.view], set: { lastReadAt: new Date() } });
  if (view === "feed") {
    const recent = await db.select({ id: teamMessages.id }).from(teamMessages).where(viewWhere(space.teamId, "feed")).orderBy(desc(teamMessages.createdAt)).limit(50);
    if (recent.length) await db.insert(teamMessageReads).values(recent.map((r) => ({ messageId: r.id, userId }))).onConflictDoNothing();
  }
}

export async function report(userId: string, space: Space, messageId: string, reason: string) {
  const m = await messageInSpace(space, messageId);
  await db.insert(teamMessageReports).values({ messageId: m.id, reporterUserId: userId, reason });
}

export async function setMuted(userId: string, space: Space, muted: boolean) {
  if (space.role === "admin") return;
  await db
    .insert(teamPrefs)
    .values({ teamId: space.teamId, userId, muted })
    .onConflictDoUpdate({ target: [teamPrefs.teamId, teamPrefs.userId], set: { muted, updatedAt: new Date() } });
}

/* ---------------- schedule and RSVPs ---------------- */

export async function events(space: Space) {
  const list = space.readOnly ? [] : await upcoming(space.teamId);
  const roster = await db.select({ playerId: rosterEntries.playerId }).from(rosterEntries).where(eq(rosterEntries.teamId, space.teamId));
  const all = await rsvpsFor(list, roster.map((r) => r.playerId));
  const names = await childNames(space.playerIds);
  return list.map((e) => {
    const mine = all.filter((r) => r.eventId === e.id);
    const count = (s: string) => mine.filter((r) => r.status === s).length;
    return {
      ...e,
      counts: { yes: count("yes"), maybe: count("maybe"), no: count("no"), none: roster.length - mine.length },
      myRsvps: space.playerIds.map((pid) => ({ playerId: pid, name: names.get(pid) ?? "", status: mine.find((r) => r.playerId === pid)?.status ?? null, note: mine.find((r) => r.playerId === pid)?.note ?? null })),
    };
  });
}

export async function setRsvp(userId: string, space: Space, input: { eventType: "game" | "practice"; eventId: string; playerId: string; status: "yes" | "maybe" | "no"; note?: string }) {
  if (space.readOnly || space.role === "admin") throw new HttpError(403, "FORBIDDEN", "You can't answer for this team.");
  const ev = await eventOfTeam(space.teamId, input.eventType, input.eventId);
  if (!ev) throw new HttpError(404, "NOT_FOUND", "That game or practice isn't on this team's schedule.");
  const [onTeam] = await db.select({ id: rosterEntries.id }).from(rosterEntries).where(and(eq(rosterEntries.teamId, space.teamId), eq(rosterEntries.playerId, input.playerId)));
  if (!onTeam) throw new HttpError(404, "NOT_FOUND", "That player isn't on this team.");
  if (space.role !== "staff" && !space.playerIds.includes(input.playerId)) throw new HttpError(403, "FORBIDDEN", "You can only answer for your own child.");
  await db
    .insert(teamRsvps)
    .values({ eventType: input.eventType, eventId: input.eventId, playerId: input.playerId, status: input.status, note: input.note || null, userId })
    .onConflictDoUpdate({ target: [teamRsvps.eventType, teamRsvps.eventId, teamRsvps.playerId], set: { status: input.status, note: input.note || null, userId, updatedAt: new Date() } });
  await broadcast({ teamId: space.teamId, channel: "team", type: "rsvp", id: input.eventId });
}

/** Coaches: each player's answer for one game or practice. */
export async function eventRsvps(space: Space, eventType: "game" | "practice", eventId: string) {
  if (space.role !== "staff" && space.role !== "admin") throw new HttpError(403, "FORBIDDEN", "Only coaches see each family's answer.");
  const ev = await eventOfTeam(space.teamId, eventType, eventId);
  if (!ev) throw new HttpError(404, "NOT_FOUND", "That game or practice isn't on this team's schedule.");
  const roster = await db
    .select({ playerId: players.id, firstName: players.firstName, lastName: players.lastName, preferredName: players.preferredName })
    .from(rosterEntries)
    .innerJoin(players, eq(players.id, rosterEntries.playerId))
    .where(eq(rosterEntries.teamId, space.teamId))
    .orderBy(asc(players.lastName));
  const answers = await db
    .select({ playerId: teamRsvps.playerId, status: teamRsvps.status, note: teamRsvps.note, by: user.name })
    .from(teamRsvps)
    .leftJoin(user, eq(user.id, teamRsvps.userId))
    .where(and(eq(teamRsvps.eventType, eventType), eq(teamRsvps.eventId, eventId)));
  return {
    event: { type: eventType, id: eventId, startsAt: ev.startsAt, label: ev.label },
    players: roster.map((p) => {
      const a = answers.find((x) => x.playerId === p.playerId);
      return { playerId: p.playerId, name: `${first(p)} ${p.lastName.charAt(0)}.`, status: a?.status ?? null, note: a?.note ?? null, answeredBy: a?.by ?? null };
    }),
  };
}

/** Coaches: nudge families who haven't answered (push + email). */
export async function remindUnanswered(space: Space, eventType: "game" | "practice", eventId: string) {
  if (space.role !== "staff" || space.readOnly) throw new HttpError(403, "FORBIDDEN", "Only coaches and the team mom can send reminders.");
  const { players: list, event } = await eventRsvps(space, eventType, eventId);
  const missing = list.filter((p) => !p.status).map((p) => p.playerId);
  if (!missing.length) return { families: 0 };
  const guardians = await db
    .selectDistinct({ userId: householdMembers.userId })
    .from(players)
    .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
    .where(inArray(players.id, missing));
  const ids = guardians.map((g) => g.userId);
  const when = event.startsAt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  void pushTo(ids, space.teamId, { title: space.teamName, body: `Are you coming to ${event.label.toLowerCase()} on ${when}? Tap to answer.`, url: `/team/${space.teamId}?view=schedule` });
  const batch = randomUUID();
  for (const u of ids) {
    await queue(db, { name: "team.rsvp_reminder", aggregateType: "team", aggregateId: space.teamId, payload: { userId: u, label: event.label, when }, dedupeKey: `team.rsvp:${eventId}:${u}:${batch}` });
  }
  return { families: ids.length };
}

/* ---------------- league admins ---------------- */

export async function openReports() {
  const rows = await db
    .select({
      id: teamMessageReports.id,
      reason: teamMessageReports.reason,
      createdAt: teamMessageReports.createdAt,
      messageId: teamMessages.id,
      body: teamMessages.body,
      deletedAt: teamMessages.deletedAt,
      teamId: teams.id,
      teamName: teams.name,
      authorUserId: teamMessages.authorUserId,
    })
    .from(teamMessageReports)
    .innerJoin(teamMessages, eq(teamMessages.id, teamMessageReports.messageId))
    .innerJoin(teams, eq(teams.id, teamMessages.teamId))
    .where(isNull(teamMessageReports.resolvedAt))
    .orderBy(desc(teamMessageReports.createdAt));
  const people = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))].concat([""])));
  return rows.map(({ authorUserId, ...r }) => ({ ...r, authorName: people.find((p) => p.id === authorUserId)?.name ?? "Former member" }));
}

export async function resolveReport(adminId: string, reportId: string, removeMessage: boolean) {
  const [r] = await db.select().from(teamMessageReports).where(eq(teamMessageReports.id, reportId));
  if (!r) throw new HttpError(404, "NOT_FOUND", "Report not found.");
  await db.update(teamMessageReports).set({ resolvedAt: new Date(), resolvedBy: adminId }).where(eq(teamMessageReports.messageId, r.messageId));
  if (removeMessage) {
    const [m] = await db.select().from(teamMessages).where(eq(teamMessages.id, r.messageId));
    if (m && !m.deletedAt) {
      await db.update(teamMessages).set({ deletedAt: new Date(), deletedBy: adminId, pinned: false }).where(eq(teamMessages.id, m.id));
      await broadcast({ teamId: m.teamId, channel: m.channel, type: "delete", id: m.id });
    }
  }
}
