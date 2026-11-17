/**
 * Sharing a game: its public data, the wording families share, and the
 * addresses of its page and images. Used by the share buttons, the game page
 * (app/games/[id]) and the share images.
 */
import type { Game } from "@/lib/schedule";

export interface PublicGame {
  game: Game;
  division: { id: string; name: string; genderPolicy?: string };
  season: { id: string; name: string; seasonPassUrl: string | null };
  records: { home: Record; away: Record };
}
interface Record {
  w: number;
  l: number;
  t: number;
}

const TZ = "America/New_York";

/** "Sat, Mar 14" */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
/** "Saturday, March 14" */
export const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: TZ });
/** "9:00 AM" */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });

export const isFinal = (g: Game) => g.status === "final" && g.homeScore !== null && g.awayScore !== null;

/** Path of the game's public page. */
export const gamePath = (id: string) => `/games/${id}`;

export type ImageFormat = "og" | "square" | "story";
/** Path of one of the game's share images (download=1: saved as a file). */
export const imagePath = (id: string, format: ImageFormat, download = false) =>
  `/games/${id}/share-image?format=${format}${download ? "&download=1" : ""}`;

/** Title used for the page, the link preview and the share menu. */
export function shareTitle(g: Game) {
  if (isFinal(g)) return `Final: ${g.home} ${g.homeScore}, ${g.away} ${g.awayScore}`;
  return `${g.home} vs ${g.away} · ${shortDate(g.startsAt)}, ${clock(g.startsAt)}`;
}

/** The message that goes with the link (people can change it before sharing). */
export function shareText(g: Game, division: string) {
  if (isFinal(g)) {
    const [w, l, ws, ls] = g.homeScore! >= g.awayScore! ? [g.home, g.away, g.homeScore, g.awayScore] : [g.away, g.home, g.awayScore, g.homeScore];
    return ws === ls ? `Final: ${g.home} and ${g.away} tie ${ws}–${ls} (${division}).` : `Final: ${w} ${ws}, ${l} ${ls} (${division}).`;
  }
  if (g.status === "cancelled") return `${g.home} vs ${g.away} on ${shortDate(g.startsAt)} is cancelled (${division}).`;
  if (g.status === "postponed") return `${g.home} vs ${g.away} (${division}) is postponed. Check the schedule for the new date.`;
  return `Game day! ${g.home} vs ${g.away}, ${shortDate(g.startsAt)} at ${clock(g.startsAt)}, ${g.location} (${division}). Come cheer!`;
}

/** "3–0" or "2–1–1" */
export const recordText = (r: Record) => (r.t ? `${r.w}–${r.l}–${r.t}` : `${r.w}–${r.l}`);
