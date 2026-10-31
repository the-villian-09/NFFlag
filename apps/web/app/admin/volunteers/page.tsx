"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";
import { APP_STATUS, SCREENING } from "@/lib/volunteer";

interface Row {
  id: string;
  roleLabel: string;
  status: string;
  screeningStatus: string;
  screeningExpiresOn: string | null;
  paidAt: string | null;
  createdAt: string;
  name: string;
  email: string;
  phone: string;
  divisionName: string | null;
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}

const FILTERS = [
  { value: "submitted", label: "Needs review" },
  { value: "submitted,approved,rejected,pending_payment,processing", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "pending_payment,processing", label: "Awaiting fee" },
  { value: "rejected,withdrawn,revoked", label: "Not approved / withdrawn / removed" },
];

/** Admin: coach and team manager applications. */
export default function AdminVolunteersPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [status, setStatus] = useState("submitted");
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
      .get<{ items: Row[] }>(`/admin/staff/applications?seasonId=${seasonId}&status=${encodeURIComponent(status)}`)
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load applications.");
      });
  }, [seasonId, status, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Volunteers</h1>
      <p className="muted">
        Coach and team manager applications. Record each background check, then approve; approving gives the volunteer their role for the
        season. Rejecting refunds the fee.
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
        <label>
          Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="card">
        {!items ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No applications match.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Volunteer</th>
                  <th>Role</th>
                  <th>Division</th>
                  <th>Background check</th>
                  <th>Applied</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const s = APP_STATUS[r.status] ?? { label: r.status, tone: "muted" };
                  const sc = SCREENING[r.screeningStatus] ?? { label: r.screeningStatus, tone: "muted" };
                  return (
                    <tr key={r.id}>
                      <td data-label="">
                        <Link href={`/admin/volunteers/${r.id}`}>{r.name}</Link>
                        <br />
                        <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>
                          {r.email}
                        </span>
                      </td>
                      <td data-label="Role">{r.roleLabel}</td>
                      <td data-label="Division">{r.divisionName ?? "Any"}</td>
                      <td data-label="Check">
                        <span className={`status ${sc.tone}`}>{sc.label}</span>
                        {r.screeningExpiresOn ? <span className="muted"> · until {fmtDate(r.screeningExpiresOn)}</span> : null}
                      </td>
                      <td data-label="Applied">{fmtDateTime(r.createdAt)}</td>
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
    </main>
  );
}
