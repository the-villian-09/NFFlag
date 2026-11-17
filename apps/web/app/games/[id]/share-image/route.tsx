/**
 * Share images for a game, made on the fly from the schedule:
 *   ?format=og      1200×630, the picture in link previews (Facebook, texts, X)
 *   ?format=square  1080×1080, a post to download (Instagram, Facebook)
 *   ?format=story   1080×1920, a story to download
 * A finished game shows the final score; otherwise "Game day" (or the
 * cancelled / postponed status). &download=1 saves it as a file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { clock, isFinal, longDate, recordText, shortDate, type ImageFormat, type PublicGame } from "@/lib/game-share";
import { serverGet } from "@/lib/server-api";

export const runtime = "nodejs";

const SIZES: Record<ImageFormat, { width: number; height: number }> = {
  og: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
  story: { width: 1080, height: 1920 },
};

const C = { navy: "#011322", card: "#08213a", line: "#1d3a57", lime: "#6cf00c", blue: "#01a2ff", gold: "#ffd21f", ink: "#eef3f9", muted: "#a9bdd2", bad: "#ff8080" };

const ASSETS = join(process.cwd(), "assets", "share");
let loaded: Promise<{ fonts: { name: string; data: Buffer; weight: 600 | 700 | 800; style: "normal" }[]; logo: string; photo: string }> | null = null;
function assets() {
  loaded ??= (async () => {
    const f = (n: string) => readFile(join(ASSETS, n));
    const [t6, t7, b6, b8, logo, photo] = await Promise.all([
      f("teko-latin-600-normal.woff"),
      f("teko-latin-700-normal.woff"),
      f("barlow-semi-condensed-latin-600-normal.woff"),
      f("barlow-semi-condensed-latin-800-normal.woff"),
      f("nffl-logo.png"),
      f("story-photo.jpg"),
    ]);
    return {
      fonts: [
        { name: "Teko", data: t6, weight: 600, style: "normal" },
        { name: "Teko", data: t7, weight: 700, style: "normal" },
        { name: "Barlow", data: b6, weight: 600, style: "normal" },
        { name: "Barlow", data: b8, weight: 800, style: "normal" },
      ],
      logo: `data:image/png;base64,${logo.toString("base64")}`,
      photo: `data:image/jpeg;base64,${photo.toString("base64")}`,
    };
  })();
  return loaded;
}

/** Shrinks long team names so they stay on one line. */
const teamSize = (name: string, base: number, width: number) => Math.min(base, Math.floor((width / Math.max(name.length, 1)) * 1.9));

function headline(d: PublicGame) {
  const g = d.game;
  if (isFinal(g)) return { text: "Final", color: C.gold };
  if (g.status === "cancelled") return { text: "Cancelled", color: C.bad };
  if (g.status === "postponed") return { text: "Postponed", color: C.gold };
  return { text: "Game day", color: C.lime };
}

function Matchup({ d, size, width }: { d: PublicGame; size: number; width: number }) {
  const g = d.game;
  if (isFinal(g)) {
    const homeWon = g.homeScore! > g.awayScore!;
    const awayWon = g.awayScore! > g.homeScore!;
    const row = (name: string, score: number, won: boolean) => (
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 24, color: won ? C.ink : C.muted }}>
        <span style={{ fontSize: teamSize(name, size * 0.85, width * 0.72), fontWeight: 700, paddingTop: size * 0.12 }}>{name}</span>
        <span style={{ fontSize: size * 1.1, fontWeight: 700, color: won ? C.gold : C.muted, paddingTop: size * 0.14 }}>{score}</span>
      </div>
    );
    return (
      <div style={{ display: "flex", flexDirection: "column", fontFamily: "Teko", textTransform: "uppercase", lineHeight: 0.95 }}>
        {row(g.home, g.homeScore!, homeWon)}
        <div style={{ height: 4, background: C.line, margin: `${size * 0.1}px 0` }} />
        {row(g.away, g.awayScore!, awayWon)}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", fontFamily: "Teko", textTransform: "uppercase", lineHeight: 0.9 }}>
      <span style={{ fontSize: teamSize(g.home, size, width), fontWeight: 700, textDecoration: g.status === "cancelled" ? "line-through" : "none" }}>{g.home}</span>
      <span style={{ fontSize: size * 0.48, fontWeight: 600, color: C.blue, margin: "4px 0" }}>vs</span>
      <span style={{ fontSize: teamSize(g.away, size, width), fontWeight: 700, textDecoration: g.status === "cancelled" ? "line-through" : "none" }}>{g.away}</span>
    </div>
  );
}

function footLine(d: PublicGame) {
  const g = d.game;
  if (isFinal(g)) {
    const winner = g.homeScore! > g.awayScore! ? { name: g.home, r: d.records.home } : g.awayScore! > g.homeScore! ? { name: g.away, r: d.records.away } : null;
    return winner ? `${winner.name} ${recordText(winner.r)} this season` : shortDate(g.startsAt);
  }
  return `${shortDate(g.startsAt)} · ${clock(g.startsAt)}`;
}

function Square({ d, logo }: { d: PublicGame; logo: string }) {
  const h = headline(d);
  return (
    <div style={{ width: 1080, height: 1080, display: "flex", background: C.navy, color: C.ink, fontFamily: "Barlow", position: "relative" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 36, height: 1080, background: h.color }} />
      <div style={{ position: "absolute", right: -160, top: 240, width: 720, height: 720, borderRadius: 720, border: `56px solid ${C.card}` }} />
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 1080, padding: "68px 72px 60px 104px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: "Teko", fontSize: 128, fontWeight: 700, color: h.color, textTransform: "uppercase", lineHeight: 0.85 }}>{h.text}</span>
            <span style={{ fontWeight: 800, letterSpacing: 4, textTransform: "uppercase", fontSize: 32, color: C.muted, marginTop: 12 }}>{d.division.name}</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} width={200} height={155} alt="" />
        </div>
        <Matchup d={d} size={164} width={880} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 800, fontSize: 46 }}>{footLine(d)}</span>
            {!isFinal(d.game) && <span style={{ fontSize: 36, color: C.muted }}>{d.game.location}</span>}
          </div>
          <span style={{ fontWeight: 800, fontSize: 32, color: h.color }}>nfflag.com</span>
        </div>
      </div>
    </div>
  );
}

function Story({ d, logo, photo }: { d: PublicGame; logo: string; photo: string }) {
  const h = headline(d);
  return (
    <div style={{ width: 1080, height: 1920, display: "flex", flexDirection: "column", background: C.navy, color: C.ink, fontFamily: "Barlow", position: "relative" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo} width={1080} height={800} alt="" style={{ objectFit: "cover" }} />
      <div style={{ position: "absolute", left: 0, top: 600, width: 1080, height: 200, backgroundImage: `linear-gradient(rgba(1,19,34,0), ${C.navy})` }} />
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flexGrow: 1, padding: "20px 76px 96px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: "Teko", fontSize: 144, fontWeight: 700, color: h.color, textTransform: "uppercase", lineHeight: 0.85 }}>{h.text}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} width={196} height={152} alt="" />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 800, letterSpacing: 5, textTransform: "uppercase", fontSize: 36, color: C.muted, marginBottom: 16 }}>{d.division.name}</span>
          <Matchup d={d} size={176} width={928} />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 800, fontSize: 56 }}>{footLine(d)}</span>
          {!isFinal(d.game) && <span style={{ fontSize: 44, color: C.muted }}>{d.game.location}</span>}
        </div>
        <div style={{ display: "flex", justifyContent: "center", background: h.color, color: C.navy, padding: "30px 0", fontWeight: 800, fontSize: 40, letterSpacing: 3, textTransform: "uppercase" }}>
          Schedule at nfflag.com
        </div>
      </div>
    </div>
  );
}

function LinkCard({ d, logo }: { d: PublicGame; logo: string }) {
  const h = headline(d);
  const g = d.game;
  return (
    <div style={{ width: 1200, height: 630, display: "flex", alignItems: "center", background: C.navy, color: C.ink, fontFamily: "Barlow", position: "relative", padding: "0 72px 0 104px" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 32, height: 630, background: h.color }} />
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, width: 760 }}>
        <span style={{ fontFamily: "Teko", fontSize: 64, fontWeight: 700, color: h.color, textTransform: "uppercase", lineHeight: 0.9 }}>
          {h.text} · {d.division.name}
        </span>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8, width: 760 }}>
          <Matchup d={d} size={isFinal(g) ? 88 : 112} width={720} />
        </div>
        <span style={{ fontWeight: 800, fontSize: 36, color: C.muted, marginTop: 18 }}>{isFinal(g) ? footLine(d) : `${longDate(g.startsAt)} · ${clock(g.startsAt)} · ${g.location}`}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} width={240} height={186} alt="" />
    </div>
  );
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "game";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const format = (["og", "square", "story"] as const).find((f) => f === url.searchParams.get("format")) ?? "og";
  const d = /^[0-9a-f-]{36}$/i.test(id) ? await serverGet<PublicGame>(`/games/${id}`, 60) : null;
  if (!d) return new Response("Not found", { status: 404 });
  const a = await assets();
  const body = format === "square" ? <Square d={d} logo={a.logo} /> : format === "story" ? <Story d={d} logo={a.logo} photo={a.photo} /> : <LinkCard d={d} logo={a.logo} />;
  const headers: Record<string, string> = { "cache-control": "public, max-age=300, s-maxage=300" };
  if (url.searchParams.get("download")) {
    const name = `${safeName(`${d.game.home}-vs-${d.game.away}`)}-${format === "story" ? "story" : "post"}.png`;
    headers["content-disposition"] = `attachment; filename="${name}"`;
  }
  return new ImageResponse(body, { ...SIZES[format], fonts: a.fonts, headers });
}
