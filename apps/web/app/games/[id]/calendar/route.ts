/** "Add to calendar": the game as an .ics file (works with Apple, Google and Outlook calendars). */
import { gamePath, type PublicGame } from "@/lib/game-share";
import { serverGet } from "@/lib/server-api";

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** iCalendar text: escape \ ; , and newlines. */
const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const d = /^[0-9a-f-]{36}$/i.test(id) ? await serverGet<PublicGame>(`/games/${id}`, 60) : null;
  if (!d) return new Response("Not found", { status: 404 });
  const g = d.game;
  const start = new Date(g.startsAt);
  const end = new Date(start.getTime() + 60 * 60_000);
  const url = `${new URL(req.url).origin}${gamePath(id)}`;
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NFFL//Schedule//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:game-${id}@nfflag.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`${g.home} vs ${g.away} (${d.division.name})`)}`,
    `LOCATION:${esc(g.location)}`,
    `DESCRIPTION:${esc(`North Florida Flag League. Details: ${url}`)}`,
    `URL:${url}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="nffl-game.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}
