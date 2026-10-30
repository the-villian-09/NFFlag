"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/use-me";

interface Flag {
  key: string;
  enabled: boolean;
  description: string | null;
}

/**
 * Admin portal home. R1b adds Registrations, Eligibility, Payments and
 * Season setup screens alongside these platform controls.
 */
export default function AdminPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const { error, setError, run } = useAction();
  const canFlags = me?.permissions.includes("platform.flags.manage");

  useEffect(() => {
    if (!me) return;
    if (!isAdmin(me)) {
      router.replace("/dashboard");
      return;
    }
    if (!canFlags) return;
    api
      .get<{ items: Flag[] }>("/admin/flags")
      .then((r) => setFlags(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "SESSION_IDLE") router.replace("/sign-in");
        else setError(err.message);
      });
  }, [me, canFlags, router, setError]);

  async function toggle(flag: Flag) {
    const res = await run(() => api.put<{ flag: Flag }>(`/admin/flags/${flag.key}`, { enabled: !flag.enabled }));
    if (res) setFlags((list) => list?.map((f) => (f.key === flag.key ? res.flag : f)) ?? null);
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Admin portal</h1>
      <div className="grid">
        <div className="card">
          <h2>Registrations</h2>
          <p className="muted">Arrives with R1b (registration and payments).</p>
        </div>
        <div className="card">
          <h2>Season setup</h2>
          <p className="muted">Arrives with R1b.</p>
        </div>
      </div>

      {canFlags && (
        <section className="card" style={{ marginTop: 24 }}>
          <h2>Release switches</h2>
          <p className="muted">Turn each release on when it's been accepted. Every change is recorded in the audit log.</p>
          <ErrorAlert error={error} />
          {!flags ? (
            <p className="muted">Loading…</p>
          ) : (
            <table className="simple">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.key}>
                    <td>
                      {f.description ?? f.key}
                      <br />
                      <code className="muted">{f.key}</code>
                    </td>
                    <td>{f.enabled ? "On" : "Off"}</td>
                    <td>
                      <button className="btn ghost" onClick={() => toggle(f)}>
                        Turn {f.enabled ? "off" : "on"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
