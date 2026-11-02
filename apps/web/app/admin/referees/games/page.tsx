"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EventRow } from "@/components/event-row";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import { matchup, OFFICIAL_STATUS } from "@/lib/referees";
import { useMe } from "@/lib/use-me";

interface Official {
  id: string;
  userId: string;
  name: string;
  status: string;
  source: string;
  rateCents: number;
  paid: boolean;
}
interface Game {
  id: string;
  startsAt: string;
  location: string;
  status: string;
  division: string;
  rateCents: number;
  home: string | null;
  away: string | null;
  slots: number;
  officials: Official[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Admin: put referees on games (referees can also take open games themselves). */
export default function AdminRefereeGamesPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 14 * 86400_000)));
  const [to, setTo] = useState(iso(new Date(Date.now() + 180 * 86400_000)));
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [data, setData] = useState<{ games: Game[]; referees: { userId: string; name: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ games: Game[]; referees: { userId: string; name: string }[] }>(`/admin/referees/games?from=${from}&to=${to}`)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load games.");
      });
  }, [from, to, router]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const shown = data?.games.filter((g) => !onlyOpen || (g.status === "scheduled" && g.officials.length < g.slots)) ?? [];
  const short = data?.games.filter((g) => g.status === "scheduled" && new Date(g.startsAt) > new Date() && g.officials.length < g.slots).length ?? 0;

  return (
    <main className="page">
      <p>
        <Link href="/admin/referees">← Referees</Link>
      </p>
      <h1>Assign referees</h1>
      <p className="muted">
        Referees can take open games themselves; you can also put them on games or take them off. They&apos;re emailed either way. Pay per
        game comes from the division&apos;s referee rate.
      </p>
      <ErrorAlert error={error} />
      <div className="filters">
        <label>
          From
          <input type="date" id="games-from" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" id="games-to" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" id="games-open" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only games that need
          referees
        </label>
      </div>
      {data && (
        <p className={short ? "countdown" : "muted"}>
          {short ? `${short} upcoming game${short === 1 ? "" : "s"} still need referees.` : "Every upcoming game in this range has its referees."}
        </p>
      )}
      {!data ? (
        !error && <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            No games in this range. Add games in Admin → Schedule & scores.
          </p>
        </section>
      ) : (
        <ul className="events">
          {shown.map((g) => (
            <GameRow key={g.id} g={g} referees={data.referees} onChanged={load} />
          ))}
        </ul>
      )}
    </main>
  );
}

function GameRow({ g, referees, onChanged }: { g: Game; referees: { userId: string; name: string }[]; onChanged: () => void }) {
  const [pick, setPick] = useState("");
  const { busy, error, run } = useAction();
  const open = g.status === "scheduled" || g.status === "postponed";
  const on = new Set(g.officials.map((o) => o.userId));
  const choices = referees.filter((r) => !on.has(r.userId));

  async function add() {
    if (!pick) return;
    if ((await run(() => api.post(`/admin/referees/games/${g.id}/officials`, { userId: pick }))) !== undefined) {
      setPick("");
      onChanged();
    }
  }
  async function remove(o: Official) {
    if ((await run(() => api.del(`/admin/referees/officials/${o.id}`))) !== undefined) onChanged();
  }
  async function slots(n: number) {
    if ((await run(() => api.put(`/admin/referees/games/${g.id}/slots`, { slots: n }))) !== undefined) onChanged();
  }

  return (
    <EventRow
      startsAt={g.startsAt}
      title={matchup(g)}
      detail={`${g.division} · ${g.location} · ${money(g.rateCents)} per referee`}
      badge={g.status !== "scheduled" ? <span className="status warn">{g.status}</span> : undefined}
      extra={
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <ErrorAlert error={error} />
          <div className="official-chips">
            <span className={g.officials.length < g.slots ? "status warn" : "status ok"}>
              {g.officials.length} of {g.slots}
            </span>
            {g.officials.map((o) => {
              const s = o.status === "assigned" ? null : OFFICIAL_STATUS[o.status];
              return (
                <span key={o.id} className="chip">
                  {o.name}
                  {o.source === "claimed" && <span className="muted"> (took it)</span>}
                  {s && <span className={`status ${s.tone}`}>{s.label}</span>}
                  {o.paid && <span className="status ok">Paid</span>}
                  {!o.paid && (
                    <button type="button" aria-label={`Remove ${o.name}`} title="Remove" onClick={() => remove(o)} disabled={busy}>
                      ✕
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          {open && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select aria-label="Referee to add" value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || g.officials.length >= g.slots}>
                <option value="">{g.officials.length >= g.slots ? "All spots filled" : "Add a referee…"}</option>
                {choices.map((r) => (
                  <option key={r.userId} value={r.userId}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button className="btn small" onClick={add} disabled={busy || !pick}>
                Add
              </button>
              <span className="muted">Spots:</span>
              <button className="btn ghost small" aria-label="One fewer spot" onClick={() => slots(g.slots - 1)} disabled={busy || g.slots <= g.officials.length}>
                −
              </button>
              <button className="btn ghost small" aria-label="One more spot" onClick={() => slots(g.slots + 1)} disabled={busy || g.slots >= 6}>
                +
              </button>
            </div>
          )}
        </div>
      }
    />
  );
}
