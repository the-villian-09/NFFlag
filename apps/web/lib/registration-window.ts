/** Where registration stands, for the home page countdown and the phone Register bar. */
export interface RegWindow {
  state: "before" | "open" | "closed" | "unknown";
  /** Whole days until it opens (before) or closes (open); null when there's no date. */
  days: number | null;
  /** e.g. "Opens Dec 1 · 5 days", "Open · closes in 3 days". */
  short: string;
}

const DAY = 86_400_000;
const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function registrationWindow(opensAt?: string | null, closesAt?: string | null, now = new Date()): RegWindow {
  const opens = opensAt ? new Date(opensAt) : null;
  const closes = closesAt ? new Date(closesAt) : null;
  if (opens && opens > now) {
    const days = Math.ceil((opens.getTime() - now.getTime()) / DAY);
    return { state: "before", days, short: `Opens ${fmt(opens)} · ${days === 1 ? "tomorrow" : `${days} days`}` };
  }
  if (closes && closes <= now) return { state: "closed", days: null, short: "Registration is closed" };
  if (opens) {
    const days = closes ? Math.ceil((closes.getTime() - now.getTime()) / DAY) : null;
    return { state: "open", days, short: days === null ? "Registration is open" : days <= 1 ? "Open · closes today" : `Open · closes in ${days} days` };
  }
  return { state: "unknown", days: null, short: "" };
}
