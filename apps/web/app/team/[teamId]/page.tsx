"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import {
  currentPush,
  disablePush,
  enablePush,
  needsHomeScreen,
  RSVP_LABEL,
  STAFF_ROLE,
  stamp,
  useTeamLive,
  when,
  type EventWithRsvps,
  type Message,
  type Rsvp,
  type SpaceDetail,
  type SpaceSummary,
  type View,
} from "@/lib/team-chat";

type Tab = "feed" | "chat" | "schedule" | "staff" | "team";
const TAB_LABEL: Record<Tab, string> = { feed: "Updates", chat: "Chat", schedule: "Schedule", staff: "Staff", team: "Team" };

export default function TeamSpacePage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <TeamSpace />
    </Suspense>
  );
}

function TeamSpace() {
  const { teamId } = useParams<{ teamId: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { me, loading } = useMe();
  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [mine, setMine] = useState<SpaceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tab = (search.get("view") as Tab | null) ?? "feed";
  const [unread, setUnread] = useState({ feed: 0, chat: 0, staff: 0 });
  const [muted, setMuted] = useState(false);

  const loadMine = useCallback(() => {
    api
      .get<{ items: SpaceSummary[] }>("/team-spaces")
      .then((r) => {
        setMine(r.items);
        const s = r.items.find((x) => x.teamId === teamId);
        if (s) {
          setUnread(s.unread);
          setMuted(s.muted);
        }
      })
      .catch(() => {});
  }, [teamId]);

  useEffect(() => {
    if (!me) return;
    setSpace(null);
    api
      .get<SpaceDetail>(`/team-spaces/${teamId}`)
      .then(setSpace)
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setError("Team pages open soon.");
        else setError(err instanceof ApiError && err.status === 404 ? "This team isn't one of yours." : err instanceof Error ? err.message : "Couldn't load the team.");
      });
    loadMine();
  }, [me, teamId, router, loadMine]);

  const go = (t: Tab) => router.replace(`/team/${teamId}${t === "feed" ? "" : `?view=${t}`}`, { scroll: false });

  if (loading || !me) return <main className="page muted">Loading…</main>;
  if (!space)
    return (
      <main className="page">
        <p>
          <Link href="/team">← My teams</Link>
        </p>
        {error ? <ErrorAlert error={error} /> : <p className="muted">Loading…</p>}
      </main>
    );

  const tabs: Tab[] = ["feed", "chat", "schedule", ...(space.can.staffChannel ? (["staff"] as Tab[]) : []), "team"];
  const badge = (t: Tab) => (t === "feed" || t === "chat" || t === "staff" ? unread[t] : 0);

  return (
    <main className="page tc-page" style={{ ["--team" as string]: space.team.color ?? "var(--lime)" }}>
      <div className="tc-top">
        <Link href="/team">← My teams</Link>
        {mine.length > 1 && (
          <label className="tc-switch">
            <span className="sr-only">Switch team</span>
            <select value={teamId} onChange={(e) => router.push(`/team/${e.target.value}`)}>
              {mine.map((s) => (
                <option key={s.teamId} value={s.teamId}>
                  {s.teamName} ({s.role === "staff" ? (STAFF_ROLE[s.staffRole ?? ""] ?? "Staff") : s.children.map((c) => c.name).join(" & ")})
                  {s.unread.feed + s.unread.chat + s.unread.staff ? " •" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <header className="tc-header">
        <h1>{space.team.name}</h1>
        <p className="muted">
          {space.team.divisionName} · {space.team.seasonName}
          {space.role === "admin" && " · Viewing as league admin"}
          {space.role === "family" && space.children.length > 0 && ` · ${space.children.map((c) => c.name).join(" & ")}`}
        </p>
        {space.readOnly && <p className="tc-note">This season has ended. You can read past messages, but the team space is closed.</p>}
      </header>
      <nav className="tc-tabs" role="tablist" aria-label="Team sections">
        {tabs.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => go(t)}>
            {TAB_LABEL[t]}
            {badge(t) > 0 && tab !== t && <span className="tc-dot">{badge(t) > 99 ? "99+" : badge(t)}</span>}
          </button>
        ))}
      </nav>
      {(tab === "feed" || tab === "chat" || tab === "staff") && (
        <Thread key={`${teamId}:${tab}`} space={space} view={tab} me={me.user.id} onRead={() => setUnread((u) => ({ ...u, [tab]: 0 }))} onOther={loadMine} />
      )}
      {tab === "schedule" && <Schedule key={teamId} space={space} />}
      {tab === "team" && <TeamInfo space={space} muted={muted} setMuted={setMuted} />}
    </main>
  );
}

/* ---------------- updates, chat and staff chat ---------------- */

function Thread({ space, view, me, onRead, onOther }: { space: SpaceDetail; view: View; me: string; onRead: () => void; onOther: () => void }) {
  const teamId = space.team.id;
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const [members, setMembers] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const isChat = view !== "feed";

  const markRead = useCallback(() => {
    if (space.role === "admin") return;
    void api.post(`/team-spaces/${teamId}/read`, { view }).then(onRead).catch(() => {});
  }, [teamId, view, space.role, onRead]);

  const load = useCallback(() => {
    api
      .get<{ items: Message[]; more: boolean; members: number }>(`/team-spaces/${teamId}/messages?view=${view}`)
      .then((r) => {
        // The API returns oldest first (right for chat); updates read newest first.
        setItems(view === "feed" ? [...r.items].reverse() : r.items);
        setMore(r.more);
        setMembers(r.members);
        markRead();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load messages."));
  }, [teamId, view, markRead]);

  useEffect(load, [load]);
  useEffect(() => {
    if (isChat) bottom.current?.scrollIntoView({ block: "end" });
  }, [items?.length, isChat]);

  useTeamLive(
    (e) => {
      if (e.data.teamId !== teamId) {
        onOther();
        return;
      }
      const m = e.data as Message;
      const mineView: View = m.channel === "staff" ? "staff" : m.kind === "chat" ? "chat" : "feed";
      if (e.type === "message") {
        if (mineView !== view) return onOther();
        setItems((list) => (list && !list.some((x) => x.id === m.id) ? [...(view === "feed" ? [] : list), m, ...(view === "feed" ? list : [])] : list));
        if (m.pinned) setItems((list) => list?.map((x) => (x.id === m.id ? x : { ...x, pinned: false })) ?? list);
        if (document.visibilityState === "visible") markRead();
      } else if (e.type === "delete") {
        setItems((list) => list?.filter((x) => x.id !== e.data.id) ?? list);
      } else if (e.type === "pin" && view === "feed") {
        load();
      }
    },
    load,
  );

  async function older() {
    if (!items?.length) return;
    const edge = view === "feed" ? items[items.length - 1]! : items[0]!;
    const r = await api.get<{ items: Message[]; more: boolean }>(`/team-spaces/${teamId}/messages?view=${view}&before=${encodeURIComponent(edge.createdAt)}`);
    setMore(r.more);
    setItems((list) => (view === "feed" ? [...(list ?? []), ...r.items.reverse()] : [...r.items, ...(list ?? [])]));
  }

  async function remove(m: Message) {
    if (!window.confirm(m.authorUserId === me ? "Remove your message?" : "Remove this message for everyone?")) return;
    try {
      await api.del(`/team-spaces/${teamId}/messages/${m.id}`);
      setItems((list) => list?.filter((x) => x.id !== m.id) ?? list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove it.");
    }
  }

  async function report(m: Message) {
    const reason = window.prompt("What's wrong with this message? A league admin will review it.");
    if (!reason) return;
    try {
      await api.post(`/team-spaces/${teamId}/messages/${m.id}/report`, { reason });
      window.alert("Thanks. A league admin will take a look.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the report.");
    }
  }

  async function pin(m: Message, pinned: boolean) {
    await api.post(`/team-spaces/${teamId}/messages/${m.id}/pin`, { pinned }).catch((err) => setError(err.message));
    load();
  }

  const canWrite = view === "feed" ? space.can.post : space.can.chat;
  const canModerate = space.role === "admin" || space.role === "staff";
  const feed = view === "feed" ? (items ?? []) : [];
  const pinned = feed.find((m) => m.pinned);

  return (
    <section className={`tc-thread ${isChat ? "is-chat" : "is-feed"}`}>
      <ErrorAlert error={error} />
      {view === "staff" && <p className="tc-note">Only coaches and the team mom see this chat.</p>}
      {view === "feed" && canWrite && <Composer space={space} view="feed" onSent={(m) => setItems((l) => (l?.some((x) => x.id === m.id) ? l : [m, ...(l ?? []).map((x) => (m.pinned ? { ...x, pinned: false } : x))]))} />}
      {items === null && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <p className="muted tc-empty">
          {view === "feed" ? "No updates yet. Coaches post game-day info and alerts here." : view === "chat" ? "No messages yet. Say hi to the team." : "No staff messages yet."}
        </p>
      )}
      {isChat && more && (
        <button type="button" className="btn ghost small tc-older" onClick={() => void older()}>
          Earlier messages
        </button>
      )}
      {pinned && (
        <Post m={pinned} me={me} members={members} staff={space.role !== "family"} canModerate={canModerate} canPin={space.can.post} onRemove={remove} onReport={report} onPin={pin} />
      )}
      {view === "feed"
        ? feed
            .filter((m) => !m.pinned)
            .map((m) => <Post key={m.id} m={m} me={me} members={members} staff={space.role !== "family"} canModerate={canModerate} canPin={space.can.post} onRemove={remove} onReport={report} onPin={pin} />)
        : (items ?? []).map((m, i, all) => (
            <Bubble key={m.id} m={m} mine={m.authorUserId === me} grouped={i > 0 && all[i - 1]!.authorUserId === m.authorUserId && +new Date(m.createdAt) - +new Date(all[i - 1]!.createdAt) < 5 * 60_000} canModerate={canModerate} onRemove={remove} onReport={report} />
          ))}
      {view === "feed" && more && (
        <button type="button" className="btn ghost small tc-older" onClick={() => void older()}>
          Older updates
        </button>
      )}
      <div ref={bottom} />
      {isChat && canWrite && <Composer space={space} view={view} onSent={(m) => setItems((l) => (l?.some((x) => x.id === m.id) ? l : [...(l ?? []), m]))} />}
      {isChat && !canWrite && space.role === "admin" && <p className="tc-note">League admins can read and remove messages here, but not post.</p>}
    </section>
  );
}

function Post(props: {
  m: Message;
  me: string;
  members: number;
  staff: boolean;
  canModerate: boolean;
  canPin: boolean;
  onRemove: (m: Message) => void;
  onReport: (m: Message) => void;
  onPin: (m: Message, pinned: boolean) => void;
}) {
  const { m } = props;
  return (
    <article className={`tc-post ${m.kind === "alert" ? "alert" : ""} ${m.pinned ? "pinned" : ""}`}>
      <header>
        <span className="tc-kicker">{m.kind === "alert" ? "Alert" : m.pinned ? "Pinned" : "Update"}</span>
        <span className="muted">
          {m.authorName}
          {m.authorLabel && ` · ${m.authorLabel}`} · {stamp(m.createdAt)}
        </span>
      </header>
      <p className="tc-body">{m.body}</p>
      <footer>
        {props.staff && m.seenCount !== null && props.members > 0 && (
          <span className="muted">
            Seen by {Math.min(m.seenCount, props.members)} of {props.members}
          </span>
        )}
        <span className="tc-actions">
          {props.canPin && m.kind !== "alert" && (
            <button type="button" className="tc-link" onClick={() => props.onPin(m, !m.pinned)}>
              {m.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {(m.authorUserId === props.me || props.canModerate) && (
            <button type="button" className="tc-link" onClick={() => props.onRemove(m)}>
              Remove
            </button>
          )}
          {m.authorUserId !== props.me && !props.canModerate && (
            <button type="button" className="tc-link" onClick={() => props.onReport(m)}>
              Report
            </button>
          )}
        </span>
      </footer>
    </article>
  );
}

function Bubble({ m, mine, grouped, canModerate, onRemove, onReport }: { m: Message; mine: boolean; grouped: boolean; canModerate: boolean; onRemove: (m: Message) => void; onReport: (m: Message) => void }) {
  const staffAuthor = m.authorLabel && !m.authorLabel.startsWith("Parent of");
  return (
    <div className={`tc-bubble-row ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}`}>
      {!grouped && !mine && (
        <div className="tc-who">
          <strong>{m.authorName}</strong> <span className={staffAuthor ? "tc-staff-tag" : "muted"}>{m.authorLabel}</span>
        </div>
      )}
      <div className="tc-bubble">
        <p className="tc-body">{m.body}</p>
      </div>
      <div className="tc-meta">
        <span>{stamp(m.createdAt)}</span>
        {(mine || canModerate) && (
          <button type="button" className="tc-link" onClick={() => onRemove(m)}>
            Remove
          </button>
        )}
        {!mine && !canModerate && (
          <button type="button" className="tc-link" onClick={() => onReport(m)}>
            Report
          </button>
        )}
      </div>
    </div>
  );
}

function Composer({ space, view, onSent }: { space: SpaceDetail; view: View; onSent: (m: Message) => void }) {
  const [body, setBody] = useState("");
  const [alert, setAlert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    if (alert && !window.confirm(`Send this alert to every family on ${space.team.name}? It goes to phones even when muted, and by email.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: Message }>(`/team-spaces/${space.team.id}/messages`, { view, body: body.trim(), ...(view === "feed" ? { alert } : {}) });
      onSent(r.message);
      setBody("");
      setAlert(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send.");
    } finally {
      setBusy(false);
    }
  }

  const label = view === "feed" ? "Post an update to the team" : view === "staff" ? "Message the staff" : "Message the team";
  return (
    <form className={`tc-composer ${view === "feed" ? "is-feed" : ""}`} onSubmit={send}>
      <ErrorAlert error={error} />
      <label className="sr-only" htmlFor={`compose-${view}`}>
        {label}
      </label>
      <textarea
        id={`compose-${view}`}
        value={body}
        maxLength={2000}
        rows={view === "feed" ? 3 : 1}
        placeholder={view === "feed" ? "Game-day info, what to bring, schedule changes…" : label}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (view !== "feed" && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
        }}
      />
      <div className="tc-composer-row">
        {view === "feed" && (
          <label className="tc-alert-toggle">
            <input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} />
            <span>
              <strong>Send as alert</strong>
              <span className="muted"> · rainouts and time changes. Pins to the top, notifies every phone and emails families.</span>
            </span>
          </label>
        )}
        <button type="submit" className={`btn small ${alert ? "danger" : ""}`} disabled={busy || !body.trim()}>
          {busy ? "Sending…" : alert ? "Send alert" : view === "feed" ? "Post" : "Send"}
        </button>
      </div>
    </form>
  );
}

/* ---------------- schedule and RSVPs ---------------- */

interface Answers {
  players: { playerId: string; name: string; status: Rsvp | null; note: string | null; answeredBy: string | null }[];
}

function Schedule({ space }: { space: SpaceDetail }) {
  const teamId = space.team.id;
  const [items, setItems] = useState<EventWithRsvps[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: EventWithRsvps[] }>(`/team-spaces/${teamId}/events`)
      .then((r) => setItems(r.items))
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the schedule."));
  }, [teamId]);
  useEffect(load, [load]);

  const loadAnswers = useCallback(
    (e: { type: string; id: string }) => {
      api
        .get<Answers>(`/team-spaces/${teamId}/events/${e.type}/${e.id}/rsvps`)
        .then(setAnswers)
        .catch((err) => setError(err.message));
    },
    [teamId],
  );

  useTeamLive((e) => {
    if (e.type !== "rsvp" || e.data.teamId !== teamId) return;
    load();
    const ev = items?.find((x) => x.id === e.data.id);
    if (ev && open === ev.id) loadAnswers(ev);
  }, load);

  async function answer(e: EventWithRsvps, playerId: string, status: Rsvp) {
    try {
      await api.put(`/team-spaces/${teamId}/rsvp`, { eventType: e.type, eventId: e.id, playerId, status });
      load();
      if (open === e.id) loadAnswers(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  async function remind(e: EventWithRsvps) {
    try {
      const r = await api.post<{ families: number }>(`/team-spaces/${teamId}/events/${e.type}/${e.id}/remind`);
      setFlash(r.families ? `Reminder sent to ${r.families} ${r.families === 1 ? "family" : "families"}.` : "Everyone has answered.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send.");
    }
  }

  return (
    <section className="tc-schedule">
      <ErrorAlert error={error} />
      {flash && <p className="tc-note ok">{flash}</p>}
      {items === null && <p className="muted">Loading…</p>}
      {items?.length === 0 && <p className="muted tc-empty">{space.readOnly ? "This season is over." : "Nothing on the schedule in the next few weeks."}</p>}
      {items?.map((e) => (
        <article key={e.id} className={`tc-event ${e.type} ${e.status === "postponed" ? "postponed" : ""}`}>
          <header>
            <span className="tc-kicker">{e.type === "game" ? "Game" : "Practice"}</span>
            {e.status === "postponed" && <span className="status warn">Postponed</span>}
          </header>
          <h3>
            {e.title} <span className="muted">· {when(e.startsAt)}</span>
          </h3>
          <p className="muted">
            {e.location}
            {e.notes ? ` · ${e.notes}` : ""}
          </p>
          {e.myRsvps.map((r) => (
            <div key={r.playerId} className="tc-rsvp-row">
              <span className="tc-rsvp-name">Is {r.name} coming?</span>
              <div className="tc-chips" role="group" aria-label={`Is ${r.name} coming?`}>
                {(["yes", "maybe", "no"] as Rsvp[]).map((v) => (
                  <button key={v} type="button" className={`tc-chip ${v}`} aria-pressed={r.status === v} disabled={space.readOnly} onClick={() => void answer(e, r.playerId, v)}>
                    {RSVP_LABEL[v]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="tc-counts">
            <span className="yes">{e.counts.yes} going</span>
            <span className="maybe">{e.counts.maybe} maybe</span>
            <span className="no">{e.counts.no} out</span>
            <span className="muted">{e.counts.none} no answer</span>
          </div>
          {space.can.seeRsvps && (
            <div className="tc-coach">
              <button
                type="button"
                className="tc-link"
                aria-expanded={open === e.id}
                onClick={() => {
                  if (open === e.id) return setOpen(null);
                  setOpen(e.id);
                  setAnswers(null);
                  loadAnswers(e);
                }}
              >
                {open === e.id ? "Hide answers" : "See each player's answer"}
              </button>
              {space.role === "staff" && !space.readOnly && e.counts.none > 0 && (
                <button type="button" className="btn ghost small" onClick={() => void remind(e)}>
                  Remind {e.counts.none} who haven&apos;t answered
                </button>
              )}
              {open === e.id && (
                <ul className="tc-answers">
                  {answers === null && <li className="muted">Loading…</li>}
                  {answers?.players.map((p) => (
                    <li key={p.playerId}>
                      <span>{p.name}</span>
                      <span className={`tc-answer ${p.status ?? "none"}`}>{p.status ? RSVP_LABEL[p.status] : "No answer"}</span>
                      {space.role === "staff" && !space.readOnly && (
                        <select aria-label={`Set ${p.name}'s answer`} value={p.status ?? ""} onChange={(ev) => ev.target.value && void answer(e, p.playerId, ev.target.value as Rsvp)}>
                          <option value="">Set…</option>
                          <option value="yes">Going</option>
                          <option value="maybe">Maybe</option>
                          <option value="no">Can&apos;t make it</option>
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

/* ---------------- members and notification settings ---------------- */

function TeamInfo({ space, muted, setMuted }: { space: SpaceDetail; muted: boolean; setMuted: (v: boolean) => void }) {
  const [push, setPush] = useState<"unknown" | "on" | "off">("unknown");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void currentPush().then((s) => setPush(s ? "on" : "off"));
  }, []);

  async function togglePush() {
    setBusy(true);
    try {
      if (push === "on") {
        await disablePush();
        setPush("off");
        setNote("Notifications are off for this device.");
      } else {
        const r = await enablePush();
        setNote(r.message);
        if (r.ok) setPush("on");
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't change notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleMute() {
    const next = !muted;
    await api.put(`/team-spaces/${space.team.id}/prefs`, { muted: next });
    setMuted(next);
  }

  const staff = space.members.filter((m) => m.role === "staff");
  const families = space.members.filter((m) => m.role === "family");
  return (
    <section className="tc-info">
      {space.role !== "admin" && (
        <div className="card">
          <h2>Notifications</h2>
          {needsHomeScreen() && push !== "on" && (
            <p className="tc-note">
              On iPhone, tap <strong>Share</strong> then <strong>Add to Home Screen</strong>, and open NFFL from your Home Screen to turn on notifications.
            </p>
          )}
          <div className="tc-setting">
            <span>
              <strong>This device</strong>
              <br />
              <span className="muted">{push === "on" ? "You'll get notifications here." : "Get alerts and messages on this phone or computer."}</span>
            </span>
            <button type="button" className={`btn small ${push === "on" ? "ghost" : ""}`} disabled={busy || push === "unknown"} onClick={() => void togglePush()}>
              {push === "on" ? "Turn off" : "Turn on"}
            </button>
          </div>
          <div className="tc-setting">
            <span>
              <strong>Mute {space.team.name}</strong>
              <br />
              <span className="muted">Muted teams still send alerts (rainouts, time changes). Nothing is sent 9 PM to 7 AM except alerts.</span>
            </span>
            <button type="button" className="btn ghost small" aria-pressed={muted} onClick={() => void toggleMute()}>
              {muted ? "Unmute" : "Mute"}
            </button>
          </div>
          {note && <p className="muted">{note}</p>}
        </div>
      )}
      <div className="card">
        <h2>Coaches & staff</h2>
        <ul className="list">
          {staff.length === 0 && <li className="muted">The league hasn&apos;t placed coaches yet.</li>}
          {staff.map((m, i) => (
            <li key={i}>
              <span className="who">{m.name}</span>
              <span className="tc-staff-tag">{m.label}</span>
            </li>
          ))}
        </ul>
        <h2 style={{ marginTop: 24 }}>Families ({space.counts.families})</h2>
        <ul className="list">
          {families.map((m, i) => (
            <li key={i}>
              <span className="who">{m.name}</span>
              <span className="muted">{m.label}</span>
            </li>
          ))}
        </ul>
        <p className="muted">Phone numbers and emails stay private. Message the team in Chat, or ask the team mom.</p>
      </div>
    </section>
  );
}
