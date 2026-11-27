"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Report {
  id: string;
  reason: string;
  createdAt: string;
  messageId: string;
  body: string;
  deletedAt: string | null;
  teamId: string;
  teamName: string;
  authorName: string;
}

/** Admin: messages families or staff reported in team spaces. */
export default function AdminTeamChatPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [items, setItems] = useState<Report[] | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(() => {
    api
      .get<{ items: Report[] }>("/admin/team-chat/reports")
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load reports.");
      });
  }, [router, setError]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  const decide = (r: Report, remove: boolean) =>
    run(async () => {
      await api.post(`/admin/team-chat/reports/${r.id}`, { remove });
      load();
    });

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page">
      <h1>Team chat reports</h1>
      <p className="muted">Messages a family or coach reported from a team page. Removing hides it for everyone on that team; both choices are kept in the audit log.</p>
      <ErrorAlert error={error} />
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted">Nothing to review.</p>}
      <ul className="list">
        {items?.map((r) => (
          <li key={r.id} style={{ display: "grid", gap: 8 }}>
            <span className="muted">
              {r.teamName} · {r.authorName} · reported {fmtDateTime(r.createdAt)}
            </span>
            <blockquote style={{ margin: 0, padding: "8px 12px", borderLeft: "4px solid var(--line)", whiteSpace: "pre-wrap" }}>{r.body}</blockquote>
            <span>
              <strong>Reason:</strong> {r.reason}
            </span>
            {r.deletedAt && <span className="status muted">Already removed</span>}
            <span style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {!r.deletedAt && (
                <button className="btn danger small" disabled={busy} onClick={() => void decide(r, true)}>
                  Remove message
                </button>
              )}
              <button className="btn ghost small" disabled={busy} onClick={() => void decide(r, false)}>
                {r.deletedAt ? "Close report" : "Keep it"}
              </button>
              <Link className="btn ghost small" href={`/team/${r.teamId}?view=chat`}>
                Open team
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
