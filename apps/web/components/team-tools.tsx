"use client";

import { useCallback, useEffect, useState } from "react";
import { EventRow } from "@/components/event-row";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { GAME_STATUS, resultFor, type Game, type Practice } from "@/lib/schedule";

interface Announcement {
  id: string;
  subject: string;
  body: string;
  recipientCount: number;
  createdAt: string;
  sentBy: string | null;
}
interface MySchedule {
  items: { team: { id: string }; games: Game[] }[];
}

/**
 * The coach's tools on My team: practices (head/assistant coach), the team's
 * games, and email announcements to the team's families.
 */
export function TeamTools({ teamId, teamName, canPractice, canAnnounce }: { teamId: string; teamName: string; canPractice: boolean; canAnnounce: boolean }) {
  const [practices, setPractices] = useState<Practice[] | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [sent, setSent] = useState<Announcement[] | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: Practice[] }>(`/teams/${teamId}/practices`)
      .then((r) => setPractices(r.items))
      .catch(() => setPractices([]));
    api
      .get<MySchedule>("/my-schedule")
      .then((r) => setGames(r.items.find((t) => t.team.id === teamId)?.games ?? []))
      .catch(() => setGames([]));
    api
      .get<{ items: Announcement[] }>(`/teams/${teamId}/announcements`)
      .then((r) => setSent(r.items))
      .catch(() => setSent([]));
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const now = Date.now();
  const upcoming = practices?.filter((p) => new Date(p.startsAt).getTime() > now - 3 * 3600_000) ?? [];

  return (
    <>
      <div className="grid" style={{ marginTop: 24, alignItems: "start" }}>
        <section className="card" id="practices">
          <h2>Practices</h2>
          {canPractice && <AddPractice teamId={teamId} onDone={load} />}
          {!practices ? (
            <p className="muted">Loading…</p>
          ) : upcoming.length === 0 ? (
            <p className="muted">No upcoming practices.{canPractice ? " Add one above; families see it on their account page." : ""}</p>
          ) : (
            <ul className="events" style={{ marginTop: 12 }}>
              {upcoming.map((p) => (
                <PracticeRow key={p.id} teamId={teamId} p={p} canEdit={canPractice} onDone={load} />
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>Games</h2>
          {!games ? (
            <p className="muted">Loading…</p>
          ) : games.length === 0 ? (
            <p className="muted">The league hasn&apos;t posted games for {teamName} yet.</p>
          ) : (
            <ul className="events">
              {games.map((g) => {
                const opp = g.homeTeamId === teamId ? g.away : g.home;
                const res = resultFor(g, teamId);
                return (
                  <EventRow
                    key={g.id}
                    startsAt={g.startsAt}
                    title={`${g.homeTeamId === teamId ? "vs" : "at"} ${opp}${res ? ` · ${res}` : ""}`}
                    detail={g.notes ? `${g.location} · ${g.notes}` : g.location}
                    struck={g.status === "cancelled"}
                    badge={g.status !== "scheduled" ? <span className={`status ${GAME_STATUS[g.status].tone}`}>{GAME_STATUS[g.status].label}</span> : null}
                  />
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 24 }} id="announce">
        <h2>Announcements</h2>
        {canAnnounce && <Compose teamId={teamId} teamName={teamName} onDone={load} />}
        {sent && sent.length > 0 && (
          <>
            <h3 style={{ marginTop: 24 }}>Sent</h3>
            <ul className="list">
              {sent.map((a) => (
                <li key={a.id} style={{ display: "block" }}>
                  <span className="who">{a.subject}</span>
                  <br />
                  <span className="muted">
                    {fmtDateTime(a.createdAt)} · {a.recipientCount} {a.recipientCount === 1 ? "recipient" : "recipients"}{a.sentBy ? ` · ${a.sentBy}` : ""}
                  </span>
                  <details style={{ marginTop: 4 }}>
                    <summary className="muted">Message</summary>
                    <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{a.body}</p>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

function AddPractice({ teamId, onDone }: { teamId: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ startsAt: "", durationMinutes: 60, location: "", notes: "" });
  if (!open)
    return (
      <button className="btn small" onClick={() => setOpen(true)}>
        + Add practice
      </button>
    );
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api.post(`/teams/${teamId}/practices`, { ...f, notes: f.notes || null }))) {
          setF({ ...f, startsAt: "", notes: "" });
          setOpen(false);
          onDone();
        }
      }}
    >
      <ErrorAlert error={error} />
      <div className="form-row">
        <label>
          Date and time
          <input type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        </label>
        <label>
          Length
          <select value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })}>
            {[45, 60, 75, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Location
        <input type="text" required maxLength={200} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Hendricks Park, Field 3" />
      </label>
      <label>
        Notes <span className="muted">(optional)</span>
        <input type="text" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Bring water and cleats" />
      </label>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button className="btn small" disabled={busy}>
          Add practice
        </button>
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PracticeRow({ teamId, p, canEdit, onDone }: { teamId: string; p: Practice; canEdit: boolean; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ startsAt: p.startsAtLocal ?? "", durationMinutes: p.durationMinutes, location: p.location, notes: p.notes ?? "", notify: true });
  const cancelled = p.status === "cancelled";

  const put = (status: "scheduled" | "cancelled", notify: boolean) =>
    run(() => api.put(`/teams/${teamId}/practices/${p.id}`, { startsAt: f.startsAt, durationMinutes: f.durationMinutes, location: f.location, notes: f.notes || null, status, notify }));

  return (
    <EventRow
      startsAt={p.startsAt}
      title={`Practice · ${p.durationMinutes} min`}
      detail={`${p.location}${p.notes ? ` · ${p.notes}` : ""}`}
      struck={cancelled}
      badge={cancelled ? <span className="status bad">Cancelled</span> : null}
      extra={
        <>
          {canEdit && !editing && (
            <span>
              <button className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setEditing(true)}>
                {cancelled ? "Restore" : "Change"}
              </button>
            </span>
          )}
      <ErrorAlert error={error} />
      {editing && (
        <form
          className="stack"
          style={{ marginTop: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (await put("scheduled", f.notify)) {
              setEditing(false);
              onDone();
            }
          }}
        >
          <div className="form-row">
            <label>
              Date and time
              <input type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
            </label>
            <label>
              Location
              <input type="text" required maxLength={200} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /> Email the team about this change
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn small" disabled={busy}>
              Save
            </button>
            {!cancelled && (
              <button
                type="button"
                className="btn ghost small"
                disabled={busy}
                onClick={async () => {
                  if (window.confirm(f.notify ? "Cancel this practice and email the team?" : "Cancel this practice?") && (await put("cancelled", f.notify))) {
                    setEditing(false);
                    onDone();
                  }
                }}
              >
                Cancel practice
              </button>
            )}
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={async () => {
                if (window.confirm("Delete this practice? It disappears without an email. To call it off, use Cancel practice.") && (await run(() => api.del(`/teams/${teamId}/practices/${p.id}`))) !== undefined) onDone();
              }}
            >
              Delete
            </button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
              Close
            </button>
          </div>
        </form>
      )}
        </>
      }
    />
  );
}

function Compose({ teamId, teamName, onDone }: { teamId: string; teamName: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ subject: "", body: "" });
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setDone(null);
        if (!window.confirm(`Email every ${teamName} family and coach?`)) return;
        const r = await run(() => api.post<{ announcement: Announcement }>(`/teams/${teamId}/announcements`, f));
        if (r) {
          setDone(`Sent to ${r.announcement.recipientCount} ${r.announcement.recipientCount === 1 ? "person" : "people"}. Replies come to your email.`);
          setF({ subject: "", body: "" });
          onDone();
        }
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        Emails every {teamName} parent and guardian plus the team&apos;s coaches. Replies go to your email address.
      </p>
      <ErrorAlert error={error} />
      {done && <div className="alert ok">{done}</div>}
      <label>
        Subject
        <input type="text" required maxLength={120} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Practice moved to Field 3" />
      </label>
      <label>
        Message
        <textarea required maxLength={5000} rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
      </label>
      <button className="btn small" disabled={busy}>
        Send email
      </button>
    </form>
  );
}
