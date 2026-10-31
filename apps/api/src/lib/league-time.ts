/**
 * League time. Games and practices are entered and shown in Jacksonville time
 * (America/New_York) no matter where the server or viewer is; stored as UTC.
 */
export const LEAGUE_TZ = "America/New_York";

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LEAGUE_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function parts(ms: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** Minutes the league clock is ahead of UTC at an instant (e.g. -300 in winter). */
function offsetMinutes(ms: number) {
  const p = parts(ms);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2027-01-10T09:00" in league time → UTC Date. Returns null for an invalid value. */
export function leagueLocalToUtc(local: string): Date | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMinutes(guess) * 60000;
  const second = offsetMinutes(t);
  t = guess - second * 60000;
  const back = parts(t);
  // Rejects dates like Feb 31 (they roll over) and the skipped DST hour.
  if (back.y !== y || back.mo !== mo || back.d !== d || back.h !== h || back.mi !== mi) return null;
  return new Date(t);
}

/** UTC → "2027-01-10T09:00" in league time (for editing forms). */
export function utcToLeagueLocal(d: Date): string {
  const p = parts(d.getTime());
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

/** Human label in league time, e.g. "Sat, Jan 10, 9:00 AM". */
export function leagueLabel(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: LEAGUE_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
