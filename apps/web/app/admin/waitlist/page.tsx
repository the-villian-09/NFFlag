"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Entry {
  id: string;
  status: "waiting" | "offered" | "accepted" | "expired" | "declined" | "removed";
  divisionId: string;
  divisionName: string;
  playerFirstName: string;
  playerLastName: string;
  birthDate: string;
  householdName: string;
  householdPhone: string | null;
  offerExpiresAt: string | null;
  createdAt: string;
  position: number | null;
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}

/** Admin: waitlists by division. Offers go out automatically within a minute of a spot opening. */
export default function AdminWaitlistPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = !!me?.permissions.includes("registrations.manage");

  useEffect(() => {
    if (!me) return;
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => {
        setSeasons(r.items);
        setSeasonId((r.items.find((s) => s.isCurrent) ?? r.items[0])?.id ?? "");
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router]);

  const load = useCallback(() => {
    if (!seasonId) return;
    api
      .get<{ items: Entry[] }>(`/admin/league/waitlist?seasonId=${seasonId}`)
      .then((r) => setItems(r.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the waitlist."));
  }, [seasonId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  const byDivision = new Map<string, Entry[]>();
  for (const e of items ?? []) byDivision.set(e.divisionName, [...(byDivision.get(e.divisionName) ?? []), e]);

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Waitlist</h1>
      <p className="muted">
        When a spot opens (a hold lapses, a registration is cancelled or rejected, or you raise a division's capacity), the next family is
        emailed an offer within a minute. The spot is held for them until the offer deadline (set under Payments), then passes to the next
        family. The waitlist release switch must be on.
      </p>
      <ErrorAlert error={error} />
      <div className="filters">
        <label>
          Season
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!items ? (
        !error && <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            No one is on a waitlist.
          </p>
        </section>
      ) : (
        [...byDivision.entries()].map(([name, list]) => (
          <section key={name} className="card" style={{ marginTop: 24 }}>
            <h2>{name}</h2>
            <div className="table-wrap">
              <table className="simple stack">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Place</th>
                    <th>Born</th>
                    <th>Family</th>
                    <th>Joined</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <WaitlistRow key={e.id} e={e} canManage={canManage} onChanged={load} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </main>
  );
}

function WaitlistRow({ e, canManage, onChanged }: { e: Entry; canManage: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  async function remove() {
    const reason = window.prompt(`Remove ${e.playerFirstName} ${e.playerLastName} from the waitlist? Reason:`);
    if (!reason || reason.trim().length < 3) return;
    if ((await run(() => api.post(`/admin/league/waitlist/${e.id}/remove`, { reason }))) !== undefined) onChanged();
  }
  return (
    <tr>
      <td data-label="">
        {e.playerFirstName} {e.playerLastName}
        {error && <div className="hint">{error}</div>}
      </td>
      <td data-label="Place">
        {e.status === "waiting" ? (
          `#${e.position}`
        ) : (
          <span className="status warn">Offered · until {e.offerExpiresAt ? fmtDateTime(e.offerExpiresAt) : "—"}</span>
        )}
      </td>
      <td data-label="Born">{fmtDate(e.birthDate)}</td>
      <td data-label="Family">
        {e.householdName}
        {e.householdPhone ? ` · ${e.householdPhone}` : ""}
      </td>
      <td data-label="Joined">{fmtDateTime(e.createdAt)}</td>
      <td data-label="">
        {canManage && (
          <button className="btn ghost small" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}
