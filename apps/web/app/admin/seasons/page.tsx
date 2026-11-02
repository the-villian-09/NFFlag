"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, GENDER_POLICY, money } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Division {
  id: string;
  name: string;
  genderPolicy: "coed" | "boys" | "girls";
  birthDateFrom: string | null;
  birthDateTo: string | null;
  eligibilityNotes: string | null;
  capacity: number;
  priceCents: number;
  refereeRateCents: number;
  status: "draft" | "open" | "full" | "closed";
  sortOrder: number;
  taken: number;
}
interface Season {
  id: string;
  name: string;
  year: number;
  status: string;
  isCurrent: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  ageCutoffDate: string | null;
  seasonPassUrl: string | null;
  divisions: Division[];
}

const SEASON_STATUS = ["planning", "registration_open", "in_season", "playoffs", "completed", "archived"];

/** <input type="datetime-local"> works in local time; the API stores UTC. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : "");

export default function AdminSeasonsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canManage = !!me?.permissions.includes("seasons.manage");

  const load = useCallback(() => {
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => setSeasons(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load seasons.");
      });
  }, [router]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Seasons and divisions</h1>
      <p className="muted">
        Families can register when the season is marked current, registration has opened (and not closed), and a division is set to Open.
        The <Link href="/admin">registration release switch</Link> must also be on.
      </p>
      <ErrorAlert error={error} />
      {!seasons ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {seasons.map((s) => (
            <SeasonCard key={s.id} season={s} canManage={canManage} onChanged={load} />
          ))}
          {canManage &&
            (adding ? (
              <section className="card" style={{ marginTop: 24 }}>
                <h2>New season</h2>
                <SeasonForm
                  onDone={() => {
                    setAdding(false);
                    load();
                  }}
                  onCancel={() => setAdding(false)}
                />
              </section>
            ) : (
              <button className="btn ghost" style={{ marginTop: 24 }} onClick={() => setAdding(true)}>
                + New season
              </button>
            ))}
        </>
      )}
    </main>
  );
}

function SeasonCard({ season, canManage, onChanged }: { season: Season; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editingDivision, setEditingDivision] = useState<Division | "new" | null>(null);
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <h2>
          {season.name} {season.isCurrent && <span className="status ok">Current</span>}
        </h2>
        {canManage && !editing && (
          <button className="btn ghost small" onClick={() => setEditing(true)}>
            Edit season
          </button>
        )}
      </div>
      {editing ? (
        <SeasonForm
          season={season}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <dl className="kv">
          <dt>Registration opens</dt>
          <dd>{fmtDateTime(season.registrationOpensAt)}</dd>
          <dt>Registration closes</dt>
          <dd>{season.registrationClosesAt ? fmtDateTime(season.registrationClosesAt) : "Not set (stays open)"}</dd>
          <dt>Age cutoff date</dt>
          <dd>{season.ageCutoffDate ?? "Not set"}</dd>
          <dt>Status</dt>
          <dd>{season.status.replace(/_/g, " ")}</dd>
          <dt>Season passes</dt>
          <dd>
            {season.seasonPassUrl ? (
              <a href={season.seasonPassUrl} target="_blank" rel="noopener noreferrer">
                {season.seasonPassUrl}
              </a>
            ) : (
              "No link (button hidden)"
            )}
          </dd>
        </dl>
      )}

      <h3 style={{ fontSize: 28, color: "#fff", marginTop: 24 }}>Divisions</h3>
      <div className="table-wrap">
        <table className="simple stack">
          <thead>
            <tr>
              <th>Division</th>
              <th>Born</th>
              <th>Price</th>
              <th>Spots</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {season.divisions.map((d) => (
              <tr key={d.id}>
                <td data-label="">
                  {d.name}
                  <br />
                  <span className="muted">{GENDER_POLICY[d.genderPolicy]}</span>
                </td>
                <td data-label="Born">
                  {d.birthDateFrom ? fmtDate(d.birthDateFrom) : "any"} – {d.birthDateTo ? fmtDate(d.birthDateTo) : "any"}
                </td>
                <td data-label="Price">{money(d.priceCents)}</td>
                <td data-label="Spots">
                  {d.taken} / {d.capacity}
                </td>
                <td data-label="Status">{d.status}</td>
                <td data-label="" style={{ textAlign: "right" }}>
                  {canManage && (
                    <button className="btn ghost small" onClick={() => setEditingDivision(d)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {season.divisions.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No divisions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editingDivision ? (
        <DivisionForm
          seasonId={season.id}
          division={editingDivision === "new" ? null : editingDivision}
          onDone={() => {
            setEditingDivision(null);
            onChanged();
          }}
          onCancel={() => setEditingDivision(null)}
        />
      ) : (
        canManage && (
          <button className="btn ghost small" onClick={() => setEditingDivision("new")}>
            + Add division
          </button>
        )
      )}
    </section>
  );
}

function SeasonForm({ season, onDone, onCancel }: { season?: Season; onDone: () => void; onCancel: () => void }) {
  const { busy, error, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name")),
      year: Number(f.get("year")),
      status: String(f.get("status")),
      registrationOpensAt: fromLocalInput(String(f.get("opens") ?? "")),
      registrationClosesAt: fromLocalInput(String(f.get("closes") ?? "")),
      ageCutoffDate: String(f.get("ageCutoffDate") ?? ""),
      seasonPassUrl: String(f.get("seasonPassUrl") ?? "").trim(),
      isCurrent: f.get("isCurrent") === "on",
    };
    const res = await run(() => (season ? api.put(`/admin/league/seasons/${season.id}`, body) : api.post("/admin/league/seasons", body)));
    if (res !== undefined) onDone();
  }
  return (
    <form className="stack" onSubmit={submit}>
      <ErrorAlert error={error} />
      <div className="form-row">
        <label>
          Name
          <input type="text" name="name" required maxLength={120} defaultValue={season?.name ?? ""} placeholder="2027 Spring Season" />
        </label>
        <label>
          Year
          <input type="number" name="year" required min={2024} max={2100} defaultValue={season?.year ?? new Date().getFullYear() + 1} />
        </label>
        <label>
          Status
          <select name="status" defaultValue={season?.status ?? "planning"}>
            {SEASON_STATUS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          Registration opens
          <input type="datetime-local" name="opens" defaultValue={toLocalInput(season?.registrationOpensAt ?? null)} />
        </label>
        <label>
          Registration closes
          <input type="datetime-local" name="closes" defaultValue={toLocalInput(season?.registrationClosesAt ?? null)} />
          <span className="hint">Leave blank to keep it open. Must be before the draft.</span>
        </label>
        <label>
          Age cutoff date
          <input type="date" name="ageCutoffDate" defaultValue={season?.ageCutoffDate ?? ""} />
          <span className="hint">For reference; eligibility uses each division's birth-date range.</span>
        </label>
      </div>
      <label>
        Season pass link <span className="muted">(optional)</span>
        <input type="url" inputMode="url" name="seasonPassUrl" maxLength={500} defaultValue={season?.seasonPassUrl ?? ""} placeholder="https://…" pattern="https://.*" title="Starts with https://" />
        <span className="hint">Your TixFlo season pass page. Shows a Season passes button at the top of the Games list on the public schedule until the season is completed.</span>
      </label>
      <label className="check">
        <input type="checkbox" name="isCurrent" defaultChecked={!!season?.isCurrent} /> This is the current season (shown to families)
      </label>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save season"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DivisionForm({ seasonId, division, onDone, onCancel }: { seasonId: string; division: Division | null; onDone: () => void; onCancel: () => void }) {
  const { busy, error, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name")),
      genderPolicy: String(f.get("genderPolicy")),
      birthDateFrom: String(f.get("birthDateFrom") ?? ""),
      birthDateTo: String(f.get("birthDateTo") ?? ""),
      eligibilityNotes: String(f.get("eligibilityNotes") ?? ""),
      capacity: Number(f.get("capacity")),
      priceCents: Math.round(Number(f.get("price")) * 100),
      refereeRateCents: Math.round(Number(f.get("refereeRate") || 0) * 100),
      status: String(f.get("status")),
      sortOrder: Number(f.get("sortOrder") || 0),
    };
    const res = await run(() =>
      division ? api.put(`/admin/league/divisions/${division.id}`, body) : api.post(`/admin/league/seasons/${seasonId}/divisions`, body),
    );
    if (res !== undefined) onDone();
  }
  return (
    <form className="stack" onSubmit={submit} style={{ background: "var(--navy)", padding: 16 }}>
      <strong style={{ color: "#fff" }}>{division ? `Edit ${division.name}` : "New division"}</strong>
      <ErrorAlert error={error} />
      <div className="form-row">
        <label>
          Name
          <input type="text" name="name" required maxLength={80} defaultValue={division?.name ?? ""} placeholder="Boys 8U" />
        </label>
        <label>
          Who can play
          <select name="genderPolicy" defaultValue={division?.genderPolicy ?? "coed"}>
            <option value="boys">Boys</option>
            <option value="girls">Girls</option>
            <option value="coed">Co-ed</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={division?.status ?? "draft"}>
            <option value="draft">Draft (hidden)</option>
            <option value="open">Open for registration</option>
            <option value="full">Full</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          Born on or after
          <input type="date" name="birthDateFrom" defaultValue={division?.birthDateFrom ?? ""} />
        </label>
        <label>
          Born on or before
          <input type="date" name="birthDateTo" defaultValue={division?.birthDateTo ?? ""} />
        </label>
        <label>
          Capacity (players)
          <input type="number" name="capacity" required min={0} max={5000} defaultValue={division?.capacity ?? 60} />
        </label>
        <label>
          Price ($)
          <input type="number" name="price" required min={0} step="0.01" defaultValue={division ? (division.priceCents / 100).toFixed(2) : "100.00"} />
        </label>
        <label>
          Referee pay per game ($)
          <input type="number" name="refereeRate" min={0} step="0.01" defaultValue={division ? ((division.refereeRateCents ?? 0) / 100).toFixed(2) : "0.00"} />
        </label>
      </div>
      <div className="form-row">
        <label>
          Note shown to families (optional)
          <input type="text" name="eligibilityNotes" maxLength={500} defaultValue={division?.eligibilityNotes ?? ""} placeholder="Ages 6–8 as of Sept 1" />
        </label>
        <label>
          Display order
          <input type="number" name="sortOrder" min={0} max={1000} defaultValue={division?.sortOrder ?? 0} />
        </label>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save division"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
