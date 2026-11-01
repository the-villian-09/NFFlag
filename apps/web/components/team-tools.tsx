"use client";

import { useCallback, useEffect, useState } from "react";
import { EventRow } from "@/components/event-row";
import { TicketButton } from "@/components/ticket-button";
import { Modal } from "@/components/modal";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import {
  GAME_STATUS,
  resultFor,
  type Game,
  type Practice,
} from "@/lib/schedule";

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
export function TeamTools({
  teamId,
  teamName,
  canPractice,
  canAnnounce,
  showPractices,
  showGames,
}: {
  teamId: string;
  teamName: string;
  canPractice: boolean;
  canAnnounce: boolean;
  showPractices: boolean;
  showGames: boolean;
}) {
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
      .then((r) =>
        setGames(r.items.find((t) => t.team.id === teamId)?.games ?? []),
      )
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
  const upcoming =
    practices?.filter(
      (p) => new Date(p.startsAt).getTime() > now - 3 * 3600_000,
    ) ?? [];
  const nextGames =
    games?.filter((g) => new Date(g.startsAt).getTime() > now - 3 * 3600_000) ??
    [];
  const [showAll, setShowAll] = useState<"practices" | "games" | null>(null);
  const SHOW = 3;
  const gameRow = (g: Game) => {
    const opp = g.homeTeamId === teamId ? g.away : g.home;
    const res = resultFor(g, teamId);
    return (
      <EventRow
        key={g.id}
        startsAt={g.startsAt}
        title={`${g.homeTeamId === teamId ? "vs" : "at"} ${opp}${res ? ` · ${res}` : ""}`}
        detail={g.notes ? `${g.location} · ${g.notes}` : g.location}
        struck={g.status === "cancelled"}
        badge={
          g.status !== "scheduled" ? (
            <span className={`status ${GAME_STATUS[g.status].tone}`}>
              {GAME_STATUS[g.status].label}
            </span>
          ) : null
        }
        action={<TicketButton g={g} />}
      />
    );
  };

  return (
    <>
      <div className="grid" style={{ marginTop: 24, alignItems: "start" }}>
        {showPractices && (
          <section className="card" id="practices">
            <h2>Practices</h2>
            {canPractice && <AddPractice teamId={teamId} onDone={load} />}
            {!practices ? (
              <p className="muted">Loading…</p>
            ) : upcoming.length === 0 ? (
              <p className="muted">
                No upcoming practices.
                {canPractice
                  ? " Add one above; families see it on their account page."
                  : ""}
              </p>
            ) : (
              <ul className="events" style={{ marginTop: 12 }}>
                {upcoming.slice(0, SHOW).map((p) => (
                  <PracticeRow
                    key={p.id}
                    teamId={teamId}
                    p={p}
                    canEdit={canPractice}
                    onDone={load}
                  />
                ))}
              </ul>
            )}
            {!!practices?.length && (
              <button
                className="btn ghost small"
                style={{ marginTop: 12 }}
                onClick={() => setShowAll("practices")}
              >
                All practices ({practices.length})
              </button>
            )}
          </section>
        )}
        {showGames && (
          <section className="card">
            <h2>Games</h2>
            {!games ? (
              <p className="muted">Loading…</p>
            ) : games.length === 0 ? (
              <p className="muted">
                The league hasn&apos;t posted games for {teamName} yet.
              </p>
            ) : nextGames.length === 0 ? (
              <p className="muted">No more games this season.</p>
            ) : (
              <ul className="events">
                {nextGames.slice(0, SHOW).map(gameRow)}
              </ul>
            )}
            {!!games?.length && (
              <button
                className="btn ghost small"
                style={{ marginTop: 12 }}
                onClick={() => setShowAll("games")}
              >
                All games ({games.length})
              </button>
            )}
          </section>
        )}
      </div>
      <Modal
        open={!!showAll}
        title={
          showAll === "games" ? `${teamName} games` : `${teamName} practices`
        }
        onClose={() => setShowAll(null)}
      >
        <ul className="events">
          {showAll === "games"
            ? games?.map(gameRow)
            : practices?.map((p) => (
                <PracticeRow
                  key={p.id}
                  teamId={teamId}
                  p={p}
                  canEdit={canPractice}
                  onDone={load}
                />
              ))}
        </ul>
      </Modal>

      {(canAnnounce || !!sent?.length) && (
        <section className="card" style={{ marginTop: 24 }} id="announce">
          <h2>Announcements</h2>
          {canAnnounce && (
            <Compose teamId={teamId} teamName={teamName} onDone={load} />
          )}
          {sent && sent.length > 0 && (
            <>
              <h3 style={{ marginTop: 24 }}>Sent</h3>
              <ul className="list">
                {sent.map((a) => (
                  <li key={a.id} style={{ display: "block" }}>
                    <span className="who">{a.subject}</span>
                    <br />
                    <span className="muted">
                      {fmtDateTime(a.createdAt)} · {a.recipientCount}{" "}
                      {a.recipientCount === 1 ? "recipient" : "recipients"}
                      {a.sentBy ? ` · ${a.sentBy}` : ""}
                    </span>
                    <details style={{ marginTop: 4 }}>
                      <summary className="muted">Message</summary>
                      <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
                        {a.body}
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Dates from start to end (inclusive) that fall on the chosen weekdays — mirrors the server. */
function countSeries(start: string, end: string, days: number[]) {
  if (!start || !end || end < start || !days.length) return 0;
  const [sy, sm, sd] = start.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = end.split("-").map(Number) as [number, number, number];
  let n = 0;
  for (
    let t = Date.UTC(sy, sm - 1, sd);
    t <= Date.UTC(ey, em - 1, ed);
    t += 86400_000
  )
    if (days.includes(new Date(t).getUTCDay())) n++;
  return n;
}

function AddPractice({
  teamId,
  onDone,
}: {
  teamId: string;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [f, setF] = useState({
    startsAt: "",
    durationMinutes: 60,
    location: "",
    notes: "",
  });
  const [r, setR] = useState({
    startDate: "",
    endDate: "",
    time: "18:00",
    weekdays: [] as number[],
  });
  const count = countSeries(r.startDate, r.endDate, r.weekdays);
  if (!open)
    return (
      <>
        {done && <div className="alert ok">{done}</div>}
        <button
          className="btn small"
          onClick={() => (setOpen(true), setDone(null))}
        >
          + Add practice
        </button>
      </>
    );
  const toggleDay = (d: number) =>
    setR({
      ...r,
      weekdays: r.weekdays.includes(d)
        ? r.weekdays.filter((x) => x !== d)
        : [...r.weekdays, d].sort(),
    });
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const common = {
          durationMinutes: f.durationMinutes,
          location: f.location,
          notes: f.notes || null,
        };
        const res = repeat
          ? await run(() =>
              api.post<{ count: number }>(`/teams/${teamId}/practices/series`, {
                ...r,
                ...common,
              }),
            )
          : await run(() =>
              api.post(`/teams/${teamId}/practices`, {
                startsAt: f.startsAt,
                ...common,
              }),
            );
        if (res) {
          setDone(
            repeat
              ? `Added ${(res as { count: number }).count} practices.`
              : "Practice added.",
          );
          setF({ ...f, startsAt: "", notes: "" });
          setOpen(false);
          onDone();
        }
      }}
    >
      <ErrorAlert error={error} />
      <div
        className="seg"
        role="radiogroup"
        aria-label="One practice or weekly"
      >
        <button
          type="button"
          role="radio"
          aria-checked={!repeat}
          onClick={() => setRepeat(false)}
        >
          One practice
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={repeat}
          onClick={() => setRepeat(true)}
        >
          Repeats weekly
        </button>
      </div>
      {repeat ? (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 700, marginBottom: 8 }}>Every</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {DAYS.map((d, i) => (
                <label
                  key={d}
                  className={`day-chip ${r.weekdays.includes(i) ? "on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={r.weekdays.includes(i)}
                    onChange={() => toggleDay(i)}
                  />
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-row">
            <label>
              Starting
              <input
                type="date"
                required
                value={r.startDate}
                onChange={(e) => setR({ ...r, startDate: e.target.value })}
              />
            </label>
            <label>
              Through
              <input
                type="date"
                required
                min={r.startDate || undefined}
                value={r.endDate}
                onChange={(e) => setR({ ...r, endDate: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Time
              <input
                type="time"
                required
                step={300}
                value={r.time}
                onChange={(e) => setR({ ...r, time: e.target.value })}
              />
            </label>
            <LengthSelect
              value={f.durationMinutes}
              onChange={(v) => setF({ ...f, durationMinutes: v })}
            />
          </div>
        </>
      ) : (
        <div className="form-row">
          <label>
            Date and time
            <input
              type="datetime-local"
              required
              value={f.startsAt}
              onChange={(e) => setF({ ...f, startsAt: e.target.value })}
            />
          </label>
          <LengthSelect
            value={f.durationMinutes}
            onChange={(v) => setF({ ...f, durationMinutes: v })}
          />
        </div>
      )}
      <label>
        Location
        <input
          type="text"
          required
          maxLength={200}
          value={f.location}
          onChange={(e) => setF({ ...f, location: e.target.value })}
          placeholder="e.g. Hendricks Park, Field 3"
        />
      </label>
      <label>
        Notes <span className="muted">(optional)</span>
        <input
          type="text"
          maxLength={500}
          value={f.notes}
          onChange={(e) => setF({ ...f, notes: e.target.value })}
          placeholder="Bring water and cleats"
        />
      </label>
      {repeat && (
        <p className="muted" style={{ margin: 0 }}>
          {count === 0
            ? "Pick the days and the dates."
            : count > 100
              ? `That's ${count} practices. Add up to 100 at a time.`
              : `Adds ${count} practice${count === 1 ? "" : "s"}. You can still change or cancel any one of them later.`}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          className="btn small"
          disabled={busy || (repeat && (count === 0 || count > 100))}
        >
          {repeat && count > 0 && count <= 100
            ? `Add ${count} practices`
            : "Add practice"}
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function LengthSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label>
      Length
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[45, 60, 75, 90, 120].map((m) => (
          <option key={m} value={m}>
            {m} min
          </option>
        ))}
      </select>
    </label>
  );
}

function PracticeRow({
  teamId,
  p,
  canEdit,
  onDone,
}: {
  teamId: string;
  p: Practice;
  canEdit: boolean;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    startsAt: p.startsAtLocal ?? "",
    durationMinutes: p.durationMinutes,
    location: p.location,
    notes: p.notes ?? "",
    notify: true,
  });
  const cancelled = p.status === "cancelled";

  const put = (status: "scheduled" | "cancelled", notify: boolean) =>
    run(() =>
      api.put(`/teams/${teamId}/practices/${p.id}`, {
        startsAt: f.startsAt,
        durationMinutes: f.durationMinutes,
        location: f.location,
        notes: f.notes || null,
        status,
        notify,
      }),
    );

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
              <button
                className="btn ghost small"
                style={{ marginTop: 8 }}
                onClick={() => setEditing(true)}
              >
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
                  <input
                    type="datetime-local"
                    required
                    value={f.startsAt}
                    onChange={(e) => setF({ ...f, startsAt: e.target.value })}
                  />
                </label>
                <label>
                  Location
                  <input
                    type="text"
                    required
                    maxLength={200}
                    value={f.location}
                    onChange={(e) => setF({ ...f, location: e.target.value })}
                  />
                </label>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={f.notify}
                  onChange={(e) => setF({ ...f, notify: e.target.checked })}
                />{" "}
                Email the team about this change
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
                      if (
                        window.confirm(
                          f.notify
                            ? "Cancel this practice and email the team?"
                            : "Cancel this practice?",
                        ) &&
                        (await put("cancelled", f.notify))
                      ) {
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
                    if (
                      window.confirm(
                        "Delete this practice? It disappears without an email. To call it off, use Cancel practice.",
                      ) &&
                      (await run(() =>
                        api.del(`/teams/${teamId}/practices/${p.id}`),
                      )) !== undefined
                    )
                      onDone();
                  }}
                >
                  Delete
                </button>
                {p.seriesId && (
                  <button
                    type="button"
                    className="btn ghost small"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        window.confirm(
                          "Delete this practice and every later one in this weekly series? No email is sent.",
                        ) &&
                        (await run(() =>
                          api.del(`/teams/${teamId}/practices/${p.id}/series`),
                        )) !== undefined
                      )
                        onDone();
                    }}
                  >
                    Delete this and later
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => setEditing(false)}
                >
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

function Compose({
  teamId,
  teamName,
  onDone,
}: {
  teamId: string;
  teamName: string;
  onDone: () => void;
}) {
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ subject: "", body: "" });
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setDone(null);
        if (!window.confirm(`Email every ${teamName} family and coach?`))
          return;
        const r = await run(() =>
          api.post<{ announcement: Announcement }>(
            `/teams/${teamId}/announcements`,
            f,
          ),
        );
        if (r) {
          setDone(
            `Sent to ${r.announcement.recipientCount} ${r.announcement.recipientCount === 1 ? "person" : "people"}. Replies come to your email.`,
          );
          setF({ subject: "", body: "" });
          onDone();
        }
      }}
    >
      <p className="muted" style={{ margin: 0 }}>
        Emails every {teamName} parent and guardian plus the team&apos;s
        coaches. Replies go to your email address.
      </p>
      <ErrorAlert error={error} />
      {done && <div className="alert ok">{done}</div>}
      <label>
        Subject
        <input
          type="text"
          required
          maxLength={120}
          value={f.subject}
          onChange={(e) => setF({ ...f, subject: e.target.value })}
          placeholder="e.g. Practice moved to Field 3"
        />
      </label>
      <label>
        Message
        <textarea
          required
          maxLength={5000}
          rows={6}
          value={f.body}
          onChange={(e) => setF({ ...f, body: e.target.value })}
        />
      </label>
      <button className="btn small" disabled={busy}>
        Send email
      </button>
    </form>
  );
}
