"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface AdminRow {
  assignmentId: string;
  roleKey: "super_admin" | "league_admin";
  grantedAt: string;
  userId: string;
  name: string;
  email: string;
}
interface UserRow {
  id: string;
  name: string;
  email: string;
}

/** Super Admin only: add or remove Admins. Admins run the league; only the Super Admin manages payments setup and admins. */
export default function AdminsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<UserRow[] | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(() => {
    api
      .get<{ items: AdminRow[] }>("/admin/admins")
      .then((r) => setAdmins(r.items))
      .catch((err) => {
        if (
          err instanceof ApiError &&
          (err.code === "SESSION_IDLE" || err.status === 401)
        )
          router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403)
          router.replace("/admin");
        else
          setError(
            err instanceof Error ? err.message : "Couldn't load admins.",
          );
      });
  }, [router, setError]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() =>
      api.get<{ items: UserRow[] }>(
        `/admin/users?q=${encodeURIComponent(q.trim())}`,
      ),
    );
    if (r) setFound(r.items);
  }

  async function add(u: UserRow) {
    if (!window.confirm(`Make ${u.name} (${u.email}) an Admin?`)) return;
    const r = await run(() =>
      api.post(`/admin/users/${u.id}/roles`, { role: "league_admin" }),
    );
    if (r) {
      setFound(null);
      setQ("");
      load();
    }
  }

  async function remove(a: AdminRow) {
    if (
      !window.confirm(
        `Remove admin access for ${a.name}? They keep their family account.`,
      )
    )
      return;
    const r = await run(() =>
      api.del(`/admin/users/${a.userId}/roles/${a.assignmentId}`),
    );
    if (r !== undefined) load();
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const adminIds = new Set(admins?.map((a) => a.userId));

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Admins</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        <strong>Admins</strong> can run the league: seasons, registrations,
        refunds, waitlist, coaches & staff, teams, the draft and site content.
        Only the <strong>Super Admin</strong> can choose the payment provider (Stripe or Square), change
        checkout settings (card fee, holds, staff fees) and add or remove
        admins.
      </p>
      <ErrorAlert error={error} />

      <section className="card">
        <h2>Current admins</h2>
        {!admins ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="list">
            {admins.map((a) => (
              <li key={a.assignmentId}>
                <span>
                  <span className="who">{a.name}</span>
                  <br />
                  <span className="muted">
                    {a.email} · since {fmtDate(a.grantedAt)}
                  </span>
                </span>
                <span
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className={`status ${a.roleKey === "super_admin" ? "warn" : "info"}`}
                  >
                    {a.roleKey === "super_admin" ? "Super Admin" : "Admin"}
                  </span>
                  {a.userId !== me.user.id && (
                    <button
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => remove(a)}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" style={{ marginTop: 24 }}>
        <h2>Add an admin</h2>
        <p className="muted">
          They need an account first. Ask them to sign up at nfflag.com, then
          find them here by email or name.
        </p>
        <form className="filters" onSubmit={search}>
          <label>
            Email or name
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              minLength={2}
              required
            />
          </label>
          <button className="btn" disabled={busy || q.trim().length < 2}>
            Search
          </button>
        </form>
        {found && (
          <ul className="list" style={{ marginTop: 16 }}>
            {found.map((u) => (
              <li key={u.id}>
                <span>
                  <span className="who">{u.name}</span>
                  <br />
                  <span className="muted">{u.email}</span>
                </span>
                {adminIds.has(u.id) ? (
                  <span className="muted">Already an admin</span>
                ) : (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => add(u)}
                  >
                    Make admin
                  </button>
                )}
              </li>
            ))}
            {found.length === 0 && (
              <li className="muted">
                No one found. They may need to sign up first.
              </li>
            )}
          </ul>
        )}
      </section>
    </main>
  );
}
