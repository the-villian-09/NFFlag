/** Schedule types and league-time formatting (always Jacksonville time). */

export interface Game {
  id: string;
  divisionId: string;
  homeTeamId: string;
  awayTeamId: string;
  home: string;
  away: string;
  startsAt: string;
  startsAtLocal: string;
  location: string;
  status: "scheduled" | "final" | "cancelled" | "postponed";
  homeScore: number | null;
  awayScore: number | null;
  notes?: string | null;
}

export interface Practice {
  id: string;
  teamId: string;
  startsAt: string;
  durationMinutes: number;
  location: string;
  notes: string | null;
  status: "scheduled" | "cancelled";
  seriesId?: string | null;
  startsAtLocal?: string;
}

export interface Standing {
  teamId: string;
  team: string;
  gp: number;
  w: number;
  l: number;
  t: number;
  pf: number;
  pa: number;
  pct: number;
}

const TZ = "America/New_York";

/** "Sat, Jan 16 · 9:00 AM" */
export function fmtWhen(iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
  return `${day} · ${time}`;
}

export const GAME_STATUS: Record<Game["status"], { label: string; tone: "ok" | "warn" | "info" | "bad" | "muted" }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  final: { label: "Final", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "bad" },
  postponed: { label: "Postponed", tone: "warn" },
};

export const pct = (p: number) => (p === 1 ? "1.000" : p.toFixed(3).replace(/^0/, ""));

/** Score text from one team's side, e.g. "W 21–14". */
export function resultFor(g: Game, teamId: string) {
  if (g.status !== "final" || g.homeScore === null || g.awayScore === null) return null;
  const us = g.homeTeamId === teamId ? g.homeScore : g.awayScore;
  const them = g.homeTeamId === teamId ? g.awayScore : g.homeScore;
  return `${us > them ? "W" : us < them ? "L" : "T"} ${us}–${them}`;
}
