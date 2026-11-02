/** What the in-season home page shows, worked out from the public schedule. */
import { IMAGE_SLOTS, siteImageUrl, type ImageSlot, type ImageSlots } from "@nffl/shared";
import type { Game, Standing } from "@/lib/schedule";

export interface HomeDivision {
  id: string;
  name: string;
  genderPolicy?: string;
  games: Game[];
  standings: Standing[];
}

const TZ = "America/New_York";
const LIVE_WINDOW = 3 * 3600_000;
export const dayKey = (iso: string | number) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { ...o, timeZone: TZ });

/** The uploaded photo for a slot, or the built-in one. */
export const imageFor = (images: Partial<ImageSlots> | undefined, slot: ImageSlot) => (images?.[slot] ? siteImageUrl(images[slot]!) : IMAGE_SLOTS[slot].fallback);

const upcoming = (g: Game, now: number) => (g.status === "scheduled" || g.status === "postponed") && new Date(g.startsAt).getTime() > now - LIVE_WINDOW;

export interface GameDay {
  /** "Today", "Tomorrow", "This Saturday", or the weekday for later weeks. */
  heading: string;
  date: string;
  firstKickoff: string;
  games: number;
  divisions: number;
  locations: string[];
}

/** The next day with games on it. */
export function nextGameDay(divs: HomeDivision[], now = Date.now()): GameDay | null {
  const all = divs.flatMap((d) => d.games.filter((g) => upcoming(g, now)).map((g) => ({ g, d: d.id })));
  if (!all.length) return null;
  all.sort((a, b) => a.g.startsAt.localeCompare(b.g.startsAt));
  const day = dayKey(all[0]!.g.startsAt);
  const that = all.filter((x) => dayKey(x.g.startsAt) === day);
  const first = that[0]!.g.startsAt;
  const days = Math.round((Date.parse(day) - Date.parse(dayKey(now))) / 86400_000);
  const weekday = fmt(first, { weekday: "long" });
  return {
    heading: days <= 0 ? "Today" : days === 1 ? "Tomorrow" : days < 7 ? `This ${weekday}` : weekday,
    date: fmt(first, { month: "short", day: "numeric" }),
    firstKickoff: fmt(first, { hour: "numeric", minute: "2-digit" }),
    games: that.length,
    divisions: new Set(that.map((x) => x.d)).size,
    locations: [...new Set(that.map((x) => x.g.location).filter(Boolean))],
  };
}

export interface ScoreDay {
  date: string;
  divisions: { id: string; name: string; gender: string; games: Game[] }[];
}

/** Every final score from the most recent day games were played. */
export function latestScores(divs: HomeDivision[], now = Date.now()): ScoreDay | null {
  const finals = divs.flatMap((d) => d.games.filter((g) => g.status === "final" && g.homeScore !== null && g.awayScore !== null && new Date(g.startsAt).getTime() <= now));
  if (!finals.length) return null;
  const last = finals.reduce((a, b) => (b.startsAt > a.startsAt ? b : a));
  const day = dayKey(last.startsAt);
  const divisions = divs
    .map((d) => ({
      id: d.id,
      name: d.name,
      gender: d.genderPolicy ?? "coed",
      games: d.games.filter((g) => g.status === "final" && g.homeScore !== null && dayKey(g.startsAt) === day).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    }))
    .filter((d) => d.games.length);
  return { date: fmt(last.startsAt, { weekday: "short", month: "short", day: "numeric" }), divisions };
}

/** Each team's record and place, for the "Your team" card. */
export function teamRecords(divs: HomeDivision[]) {
  const out: Record<string, { w: number; l: number; t: number; place: number; teams: number }> = {};
  for (const d of divs) d.standings.forEach((s, i) => (out[s.teamId] = { w: s.w, l: s.l, t: s.t, place: i + 1, teams: d.standings.length }));
  return out;
}

export const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
};
export const record = (r: { w: number; l: number; t: number }) => `${r.w}–${r.l}${r.t ? `–${r.t}` : ""}`;
