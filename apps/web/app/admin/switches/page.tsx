"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

interface Flag {
  key: string;
  enabled: boolean;
  description: string | null;
}

/** Release switches: turn each feature on when the league is ready. */
export default function SwitchesPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const { error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api
      .get<{ items: Flag[] }>("/admin/flags")
      .then((r) => setFlags(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router, setError]);

  async function toggle(flag: Flag) {
    const res = await run(() => api.put<{ flag: Flag }>(`/admin/flags/${flag.key}`, { enabled: !flag.enabled }));
    if (res) setFlags((list) => list?.map((f) => (f.key === flag.key ? res.flag : f)) ?? null);
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page">
      <h1>Release switches</h1>
      <p className="muted">
        Turn each feature on when it&apos;s been accepted. While a switch is off, families, coaches and referees don&apos;t see that
        feature; admins can still set it up and test it. Every change is recorded in the audit log.
      </p>
      <ErrorAlert error={error} />
      <section className="card">
        {!flags ? (
          <p className="muted">Loading…</p>
        ) : (
          <table className="simple stack">
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
                  <td data-label="">
                    {f.description ?? f.key}
                    <br />
                    <code className="muted">{f.key}</code>
                  </td>
                  <td data-label="Status">
                    <span className={`status ${f.enabled ? "ok" : "muted"}`}>{f.enabled ? "On" : "Off"}</span>
                  </td>
                  <td data-label="">
                    <button className="btn ghost small" onClick={() => toggle(f)}>
                      Turn {f.enabled ? "off" : "on"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
