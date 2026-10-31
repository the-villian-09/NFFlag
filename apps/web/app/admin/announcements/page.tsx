"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}
interface Division {
  id: string;
  name: string;
  teams: { id: string; name: string }[];
}
interface Sent {
  id: string;
  audience: "team" | "division" | "league";
  teamId: string | null;
  divisionId: string | null;
  subject: string;
  body: string;
  recipientCount: number;
  createdAt: string;
  sentBy: string | null;
}

/** Admin: email every family this season, one division, or one team. */
export default function AdminAnnouncementsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [season, setSeason] = useState<Season | null>(null);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [sent, setSent] = useState<Sent[] | null>(null);
  const [f, setF] = useState({ audience: "league" as Sent["audience"], divisionId: "", teamId: "", subject: "", body: "" });
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => setSeason(r.items.find((s) => s.isCurrent) ?? r.items[0] ?? null))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router, setError]);

  const load = useCallback(() => {
    if (!season) return;
    api
      .get<{ items: Sent[] }>(`/admin/schedule/announcements?seasonId=${season.id}`)
      .then((r) => setSent(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load announcements.");
      });
    api
      .get<{ divisions: Division[] }>(`/admin/schedule/seasons/${season.id}`)
      .then((r) => setDivisions(r.divisions))
      .catch(() => setDivisions([]));
  }, [season, router, setError]);

  useEffect(() => {
    load();
  }, [load]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setDone(null);
    const who = f.audience === "league" ? "every family registered this season and all team staff" : f.audience === "division" ? `every family in ${divisions.find((d) => d.id === f.divisionId)?.name}` : "this team's families and coaches";
    if (!window.confirm(`Email ${who}?`)) return;
    const payload =
      f.audience === "league"
        ? { audience: "league", subject: f.subject, body: f.body }
        : f.audience === "division"
          ? { audience: "division", divisionId: f.divisionId, subject: f.subject, body: f.body }
          : { audience: "team", teamId: f.teamId, subject: f.subject, body: f.body };
    const r = await run(() => api.post<{ announcement: Sent }>("/admin/schedule/announcements", payload));
    if (r) {
      setDone(`Sent to ${r.announcement.recipientCount} ${r.announcement.recipientCount === 1 ? "person" : "people"}.`);
      setF({ ...f, subject: "", body: "" });
      load();
    }
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const teams = divisions.flatMap((d) => d.teams.map((t) => ({ ...t, label: `${t.name} (${d.name})` })));
  const label = (a: Sent) =>
    a.audience === "league" ? "Everyone" : a.audience === "division" ? (divisions.find((d) => d.id === a.divisionId)?.name ?? "Division") : (teams.find((t) => t.id === a.teamId)?.label ?? "Team");

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Announcements</h1>
      <p className="muted">Emails go out from the league&apos;s address; replies come to you.{season ? ` Season: ${season.name}.` : ""}</p>
      <ErrorAlert error={error} />
      <div className="grid" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>New announcement</h2>
          <form className="stack" onSubmit={send}>
            {done && <div className="alert ok">{done}</div>}
            <label>
              Send to
              <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as Sent["audience"] })}>
                <option value="league">Everyone this season</option>
                <option value="division">One division</option>
                <option value="team">One team</option>
              </select>
            </label>
            {f.audience === "division" && (
              <label>
                Division
                <select required value={f.divisionId} onChange={(e) => setF({ ...f, divisionId: e.target.value })}>
                  <option value="">Choose…</option>
                  {divisions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {f.audience === "team" && (
              <label>
                Team
                <select required value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
                  <option value="">Choose…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Subject
              <input type="text" required maxLength={120} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
            </label>
            <label>
              Message
              <textarea required maxLength={5000} rows={8} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
            </label>
            <button className="btn" disabled={busy}>
              Send email
            </button>
          </form>
        </section>
        <section className="card">
          <h2>Sent</h2>
          {!sent ? (
            <p className="muted">Loading…</p>
          ) : sent.length === 0 ? (
            <p className="muted">Nothing sent this season yet.</p>
          ) : (
            <ul className="list">
              {sent.map((a) => (
                <li key={a.id} style={{ display: "block" }}>
                  <span className="who">{a.subject}</span>
                  <br />
                  <span className="muted">
                    {label(a)} · {a.recipientCount} {a.recipientCount === 1 ? "recipient" : "recipients"} · {fmtDateTime(a.createdAt)}
                    {a.sentBy ? ` · ${a.sentBy}` : ""}
                  </span>
                  <details style={{ marginTop: 4 }}>
                    <summary className="muted">Message</summary>
                    <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{a.body}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
