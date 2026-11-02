"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Entry {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  actorName: string | null;
  actorEmail: string | null;
  createdAt: string;
}

/** "registration.refund" → "Registration refund" */
const readable = (action: string) => {
  const s = action.replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Audit log: who changed what, and when (newest first). */
export default function AuditPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [items, setItems] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const more = useCallback(
    (before: string | null) => {
      setBusy(true);
      api
        .get<{ items: Entry[]; nextCursor: string | null }>(`/admin/audit?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`)
        .then((r) => {
          setItems((list) => (before ? [...list, ...r.items] : r.items));
          setCursor(r.nextCursor);
          setDone(!r.nextCursor);
        })
        .catch((err) => {
          if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
          else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
          else setError(err instanceof Error ? err.message : "Couldn't load the audit log.");
        })
        .finally(() => setBusy(false));
    },
    [router],
  );
  useEffect(() => {
    if (me) more(null);
  }, [me, more]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page">
      <h1>Audit log</h1>
      <p className="muted">Every sensitive change: who made it, what changed and when. Newest first.</p>
      <ErrorAlert error={error} />
      <section className="card">
        <div className="table-wrap">
          <table className="simple stack">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td data-label="When">{fmtDateTime(e.createdAt)}</td>
                  <td data-label="Who">{e.actorName ?? (e.actorEmail || "System")}</td>
                  <td data-label="What">
                    {readable(e.action)}
                    <br />
                    <span className="muted" style={{ fontSize: 14 }}>
                      {e.targetType.replace(/_/g, " ")}
                      {e.targetId ? ` · ${e.targetId.slice(0, 8)}` : ""}
                    </span>
                  </td>
                  <td data-label="Reason">{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!done && (
          <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => more(cursor)} disabled={busy}>
            {busy ? "Loading…" : "Show older"}
          </button>
        )}
      </section>
    </main>
  );
}
