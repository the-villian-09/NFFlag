"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { Modal } from "@/components/modal";
import { api, ApiError } from "@/lib/api";
import { fmtDate, money } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Promo {
  id: string;
  code: string;
  description: string | null;
  kind: "percent" | "amount";
  value: number;
  appliesTo: "registration" | "staff" | "both";
  seasonId: string | null;
  seasonName: string | null;
  divisionIds: string[];
  maxUses: number | null;
  onePerFamily: boolean;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  uses: number;
  savedCents: number;
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
  divisions?: { id: string; name: string }[];
}
interface Division {
  id: string;
  name: string;
}

const APPLIES: Record<Promo["appliesTo"], string> = { registration: "Player registration", staff: "Coach & team mom fees", both: "Registration and staff fees" };
const off = (p: Pick<Promo, "kind" | "value">) => (p.kind === "percent" ? `${p.value}% off` : `${money(p.value)} off`);
const dateOnly = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "");

/** Admin: promo codes for registration and staff fees, with how often each has been used. */
export default function PromoCodesPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [items, setItems] = useState<Promo[] | null>(null);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [editing, setEditing] = useState<Promo | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(() => {
    api
      .get<{ items: Promo[] }>("/admin/promo-codes")
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load promo codes.");
      });
  }, [router]);

  useEffect(() => {
    if (!me) return;
    load();
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => setSeasons(r.items))
      .catch(() => setSeasons([]));
  }, [me, load]);

  async function toggle(p: Promo) {
    const body = { ...p, divisionIds: p.divisionIds ?? [], active: !p.active };
    if (await run(() => api.put(`/admin/promo-codes/${p.id}`, body))) load();
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Promo codes</h1>
        <button className="btn" onClick={() => setEditing("new")}>
          + New code
        </button>
      </div>
      <p className="muted" style={{ maxWidth: 760 }}>
        Families enter a code at checkout. The discount comes off the price before any card fee. A code is &ldquo;used&rdquo; while a registration or
        application holds it; cancelled, expired or rejected ones free the use.
      </p>
      <ErrorAlert error={error} />
      <section className="card">
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No codes yet.</p>
        ) : (
          <ul className="list">
            {items.map((p) => (
              <li key={p.id}>
                <span>
                  <span className="who" style={{ letterSpacing: "0.04em" }}>
                    {p.code}
                  </span>{" "}
                  <span className={`status ${p.active ? "ok" : "muted"}`}>{p.active ? "Active" : "Paused"}</span>
                  <br />
                  <span className="muted">
                    {off(p)} · {APPLIES[p.appliesTo]}
                    {p.seasonName ? ` · ${p.seasonName}` : ""}
                    {p.divisionIds?.length ? ` · ${p.divisionIds.length} division${p.divisionIds.length === 1 ? "" : "s"}` : ""}
                    {p.onePerFamily ? " · once per family" : ""}
                    {p.startsAt || p.endsAt ? ` · ${p.startsAt ? fmtDate(p.startsAt) : "now"} – ${p.endsAt ? fmtDate(p.endsAt) : "no end"}` : ""}
                  </span>
                  <br />
                  <span>
                    Used {p.uses}
                    {p.maxUses ? ` of ${p.maxUses}` : ""} · {money(p.savedCents)} off completed checkouts
                  </span>
                  {p.description && (
                    <>
                      <br />
                      <span className="muted">{p.description}</span>
                    </>
                  )}
                </span>
                <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn ghost small" onClick={() => setEditing(p)}>
                    Edit
                  </button>
                  <button className="btn ghost small" disabled={busy} onClick={() => toggle(p)}>
                    {p.active ? "Pause" : "Resume"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Modal open={!!editing} title={editing === "new" ? "New promo code" : editing ? `Edit ${editing.code}` : ""} onClose={() => setEditing(null)}>
        {editing && (
          <PromoForm
            key={editing === "new" ? "new" : editing.id}
            initial={editing === "new" ? null : editing}
            seasons={seasons}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        )}
      </Modal>
    </main>
  );
}

function PromoForm({ initial, seasons, onSaved }: { initial: Promo | null; seasons: Season[]; onSaved: () => void }) {
  const { busy, error, run } = useAction();
  const [f, setF] = useState({
    code: initial?.code ?? "",
    description: initial?.description ?? "",
    kind: initial?.kind ?? ("percent" as Promo["kind"]),
    amount: initial ? (initial.kind === "percent" ? String(initial.value) : (initial.value / 100).toFixed(2)) : "",
    appliesTo: initial?.appliesTo ?? ("registration" as Promo["appliesTo"]),
    seasonId: initial?.seasonId ?? seasons.find((s) => s.isCurrent)?.id ?? "",
    divisionIds: initial?.divisionIds ?? [],
    maxUses: initial?.maxUses ? String(initial.maxUses) : "",
    onePerFamily: initial?.onePerFamily ?? false,
    startsOn: dateOnly(initial?.startsAt ?? null),
    endsOn: dateOnly(initial?.endsAt ?? null),
    active: initial?.active ?? true,
  });
  const divisions: Division[] = seasons.find((x) => x.id === f.seasonId)?.divisions ?? [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = f.kind === "percent" ? Math.round(Number(f.amount)) : Math.round(Number(f.amount) * 100);
    const body = {
      code: f.code,
      description: f.description || null,
      kind: f.kind,
      value,
      appliesTo: f.appliesTo,
      seasonId: f.seasonId || null,
      divisionIds: f.appliesTo === "staff" || !f.seasonId ? [] : f.divisionIds,
      maxUses: f.maxUses ? Number(f.maxUses) : null,
      onePerFamily: f.onePerFamily,
      // League time: starts at the beginning of the first day, ends at the end of the last.
      startsAt: f.startsOn ? new Date(`${f.startsOn}T00:00:00`).toISOString() : null,
      endsAt: f.endsOn ? new Date(`${f.endsOn}T23:59:59`).toISOString() : null,
      active: f.active,
    };
    const r = await run(() => (initial ? api.put(`/admin/promo-codes/${initial.id}`, body) : api.post("/admin/promo-codes", body)));
    if (r) onSaved();
  }

  return (
    <form className="stack" onSubmit={save} style={{ marginTop: 0 }}>
      <ErrorAlert error={error} />
      {initial && initial.uses > 0 && <p className="muted" style={{ margin: 0 }}>Changes apply to future checkouts. {initial.uses} family(ies) who already used it keep their price.</p>}
      <div className="form-row">
        <label>
          Code
          <input type="text" required minLength={3} maxLength={30} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/\s/g, "") })} placeholder="EARLYBIRD" />
        </label>
        <label>
          Note <span className="muted">(admins only)</span>
          <input type="text" maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Sponsor: Hendricks Pizza" />
        </label>
      </div>
      <div className="form-row">
        <label>
          Discount
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Promo["kind"], amount: "" })}>
            <option value="percent">Percent off</option>
            <option value="amount">Dollars off</option>
          </select>
        </label>
        <label>
          {f.kind === "percent" ? "Percent (1–100)" : "Amount ($)"}
          <input
            type="number"
            required
            min={f.kind === "percent" ? 1 : 0.01}
            max={f.kind === "percent" ? 100 : undefined}
            step={f.kind === "percent" ? 1 : 0.01}
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </label>
      </div>
      <label>
        Works on
        <select value={f.appliesTo} onChange={(e) => setF({ ...f, appliesTo: e.target.value as Promo["appliesTo"] })}>
          <option value="registration">Player registration</option>
          <option value="staff">Coach & team mom fees</option>
          <option value="both">Both</option>
        </select>
      </label>
      <label>
        Season
        <select value={f.seasonId} onChange={(e) => setF({ ...f, seasonId: e.target.value, divisionIds: [] })}>
          <option value="">Any season</option>
          {seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {f.appliesTo !== "staff" && f.seasonId && divisions.length > 0 && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 700, marginBottom: 6 }}>Divisions</legend>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 15 }}>
            Leave all unticked for every division.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {divisions.map((d) => (
              <label key={d.id} className={`day-chip ${f.divisionIds.includes(d.id) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={f.divisionIds.includes(d.id)}
                  onChange={() =>
                    setF({ ...f, divisionIds: f.divisionIds.includes(d.id) ? f.divisionIds.filter((x) => x !== d.id) : [...f.divisionIds, d.id] })
                  }
                />
                {d.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="form-row">
        <label>
          Starts <span className="muted">(optional)</span>
          <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} />
        </label>
        <label>
          Ends <span className="muted">(optional)</span>
          <input type="date" min={f.startsOn || undefined} value={f.endsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} />
        </label>
      </div>
      <label>
        Total uses <span className="muted">(optional; blank = unlimited)</span>
        <input type="number" min={1} step={1} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.onePerFamily} onChange={(e) => setF({ ...f, onePerFamily: e.target.checked })} /> Once per family
      </label>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
      </label>
      <button className="btn" disabled={busy}>
        {initial ? "Save changes" : "Create code"}
      </button>
    </form>
  );
}
