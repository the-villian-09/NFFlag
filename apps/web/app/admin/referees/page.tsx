"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { PAYOUT_SETUP, REF_STATUS } from "@/lib/referees";
import { useMe } from "@/lib/use-me";
import { SCREENING } from "@/lib/volunteer";

interface Row {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: string;
  age: number;
  meetsMinAge: boolean;
  certification: string;
  certificationExpiresOn: string | null;
  certificationVerified: boolean;
  certificationExpired: boolean;
  screeningStatus: string;
  payoutSetup: string;
  createdAt: string;
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}
interface Settings {
  minAge: number;
  dropCutoffHours: number;
  defaultSlots: number;
}

const ORDER = ["submitted", "approved", "revoked", "rejected", "withdrawn"];

/** Admin: referee sign-ups, with links to game assignments and pay. */
export default function AdminRefereesPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [items, setItems] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router]);

  useEffect(() => {
    if (!seasonId) return;
    api
      .get<{ items: Row[] }>(`/admin/referees/applications?seasonId=${seasonId}`)
      .then((r) => setItems([...r.items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name))))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load referees.");
      });
  }, [seasonId, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const canPay = me.permissions.includes("referees.pay");
  const counts = (s: string) => items?.filter((i) => i.status === s).length ?? 0;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Referees</h1>
      <p className="muted">
        Review sign-ups: record the background check and verify the certification, then approve. Approved referees set up payouts with
        Stripe and pick games; you can also assign them.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "16px 0" }}>
        <Link className="btn" href="/admin/referees/games">
          Assign games
        </Link>
        {canPay && (
          <Link className="btn" href="/admin/referees/pay">
            Pay referees
          </Link>
        )}
      </div>
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
      {items && (
        <p className="muted">
          {counts("submitted")} to review · {counts("approved")} approved
        </p>
      )}
      <section className="card">
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No referee sign-ups this season yet. Referees sign up at nfflag.com/referees once the Referees release switch is on.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Referee</th>
                  <th>Age</th>
                  <th>Certification</th>
                  <th>Background check</th>
                  <th>Payouts</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const s = REF_STATUS[r.status] ?? { label: r.status, tone: "muted" };
                  const sc = SCREENING[r.screeningStatus] ?? { label: r.screeningStatus, tone: "muted" };
                  const ps = PAYOUT_SETUP[r.payoutSetup] ?? { label: r.payoutSetup, tone: "muted" };
                  return (
                    <tr key={r.id}>
                      <td data-label="">
                        <Link href={`/admin/referees/${r.id}`}>{r.name}</Link>
                        <br />
                        <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>
                          {r.email}
                        </span>
                      </td>
                      <td data-label="Age">
                        {r.age}
                        {!r.meetsMinAge && <span className="status bad"> Too young</span>}
                      </td>
                      <td data-label="Certification">
                        {r.certification}
                        <br />
                        {r.certificationExpired ? (
                          <span className="status bad">Expired</span>
                        ) : r.certificationVerified ? (
                          <span className="status ok">Verified</span>
                        ) : (
                          <span className="status warn">Not verified</span>
                        )}
                        {r.certificationExpiresOn && <span className="muted"> · until {fmtDate(r.certificationExpiresOn)}</span>}
                      </td>
                      <td data-label="Check">
                        <span className={`status ${sc.tone}`}>{sc.label}</span>
                      </td>
                      <td data-label="Payouts">
                        <span className={`status ${ps.tone}`}>{ps.label}</span>
                      </td>
                      <td data-label="Status">
                        <span className={`status ${s.tone}`}>{s.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <SettingsCard />
    </main>
  );
}

function SettingsCard() {
  const [v, setV] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api
      .get<{ settings: Settings }>("/admin/referees/settings")
      .then((r) => setV(r.settings))
      .catch(() => undefined);
  }, []);
  if (!v) return null;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if ((await run(() => api.put("/admin/referees/settings", v))) !== undefined) setSaved(true);
  }
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Referee rules</h2>
      <p className="muted">Pay per game is set on each division (Admin → Seasons & divisions).</p>
      <form className="stack" onSubmit={save}>
        <ErrorAlert error={error} />
        {saved && <div className="alert ok">Saved.</div>}
        <div className="form-row">
          <label>
            Minimum age
            <input type="number" id="ref-min-age" min={12} max={30} value={v.minAge} onChange={(e) => setV({ ...v, minAge: Number(e.target.value) })} />
          </label>
          <label>
            Referees can drop a game until (hours before)
            <input
              type="number"
              id="ref-drop"
              min={0}
              max={168}
              value={v.dropCutoffHours}
              onChange={(e) => setV({ ...v, dropCutoffHours: Number(e.target.value) })}
            />
          </label>
          <label>
            Referees per new game
            <input
              type="number"
              id="ref-slots"
              min={0}
              max={6}
              value={v.defaultSlots}
              onChange={(e) => setV({ ...v, defaultSlots: Number(e.target.value) })}
            />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  );
}
