"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, money, STATUS, StatusBadge } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Row {
  id: string;
  status: string;
  totalCents: number;
  paidAt: string | null;
  createdAt: string;
  playerFirstName: string;
  playerLastName: string;
  birthDate: string;
  gender: string;
  divisionName: string;
  householdName: string;
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
  divisions: { id: string; name: string }[];
}

const FILTERS: { value: string; label: string }[] = [
  { value: "paid", label: "Needs review" },
  { value: "withdrawal", label: "Withdrawal requests" },
  { value: "paid,approved,rejected,processing,pending_payment", label: "All active" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Not accepted" },
  { value: "pending_payment", label: "Awaiting payment" },
  { value: "processing", label: "Confirming payment" },
  { value: "cancelled,expired", label: "Cancelled / expired" },
];

export default function AdminRegistrationsPage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <RegistrationsList />
    </Suspense>
  );
}

function RegistrationsList() {
  const params = useSearchParams();
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [divisionId, setDivisionId] = useState("");
  // ?show=withdrawal opens straight to withdrawal requests (link from the admin home).
  const [status, setStatus] = useState(params.get("show") === "withdrawal" ? "withdrawal" : "paid");
  // Arriving again from a link (e.g. the admin home) switches the filter.
  useEffect(() => {
    if (params.get("show") === "withdrawal") setStatus("withdrawal");
  }, [params]);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Row[]; total: number; pageSize: number } | null>(null);
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
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router]);

  const query = new URLSearchParams({
    ...(seasonId ? { seasonId } : {}),
    ...(divisionId ? { divisionId } : {}),
    ...(status === "withdrawal" ? { status: "paid,approved", withdrawal: "open" } : { status }),
    ...(q ? { q } : {}),
  });

  useEffect(() => {
    if (!me || !seasons.length) return;
    const t = setTimeout(() => {
      api
        .get<{ items: Row[]; total: number; pageSize: number }>(`/admin/league/registrations?${query.toString()}&page=${page}`)
        .then(setData)
        .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load registrations."));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, seasons.length, seasonId, divisionId, status, q, page]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const season = seasons.find((s) => s.id === seasonId);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Registrations</h1>
      <ErrorAlert error={error} />
      <div className="filters">
        <label>
          Season
          <select value={seasonId} onChange={(e) => (setSeasonId(e.target.value), setDivisionId(""), setPage(1))}>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Division
          <select value={divisionId} onChange={(e) => (setDivisionId(e.target.value), setPage(1))}>
            <option value="">All divisions</option>
            {season?.divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input type="search" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} placeholder="Player or family name" />
        </label>
      </div>
      {me.permissions.includes("registrations.export") && (
        <p>
          <a className="btn ghost small" href={`/api/v1/admin/league/registrations/export.csv?${query.toString()}`}>
            Download spreadsheet (CSV)
          </a>
        </p>
      )}
      <section className="card">
        {!data ? (
          <p className="muted">Loading…</p>
        ) : data.items.length === 0 ? (
          <p className="muted">No registrations match.</p>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              {data.total} registration{data.total === 1 ? "" : "s"} · {STATUS[status]?.label ?? FILTERS.find((f) => f.value === status)?.label}
            </p>
            <div className="table-wrap">
              <table className="simple stack">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Born</th>
                    <th>Division</th>
                    <th>Family</th>
                    <th>Paid</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id}>
                      <td data-label="">
                        <Link href={`/admin/registrations/${r.id}`}>
                          {r.playerFirstName} {r.playerLastName}
                        </Link>
                      </td>
                      <td data-label="Born">{fmtDate(r.birthDate)}</td>
                      <td data-label="Division">{r.divisionName}</td>
                      <td data-label="Family">{r.householdName}</td>
                      <td data-label="Paid">
                        {r.paidAt ? (
                          <>
                            {money(r.totalCents)}
                            <br />
                            <span className="muted">{fmtDateTime(r.paidAt)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="Status">
                        <StatusBadge status={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </button>
                <span className="muted">
                  Page {page} of {pages}
                </span>
                <button className="btn ghost small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
