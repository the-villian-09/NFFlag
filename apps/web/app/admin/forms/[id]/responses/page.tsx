"use client";

/** Admin: who has and hasn't completed a form, reminders, answers and the spreadsheet. */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import type { FormQuestion } from "@/components/form-fields";
import { Modal } from "@/components/modal";
import { api, ApiError } from "@/lib/api";
import { AUDIENCE, type Audience } from "@/lib/forms";
import { useMe } from "@/lib/use-me";

interface Row {
  subjectType: string;
  subjectId: string;
  name: string;
  detail: string;
  divisionId: string | null;
  contacts: string;
  done: boolean;
  response: { agreed: boolean; signerName: string; signedAt: string; version: number; answers: Record<string, string> } | null;
}
interface FormInfo {
  form: { id: string; title: string; audience: Audience; required: boolean; status: string; askExisting: boolean; dueDate: string | null; version: number; questions: FormQuestion[] };
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

export default function FormResponsesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [remindedAt, setRemindedAt] = useState<string | null>(null);
  const [show, setShow] = useState<"missing" | "done" | "all">("missing");
  const [division, setDivision] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    Promise.all([api.get<FormInfo>(`/admin/forms/${id}`), api.get<{ rows: Row[]; remindedAt: string | null }>(`/admin/forms/${id}/tracking`)])
      .then(([f, t]) => {
        setInfo(f);
        setRows(t.rows);
        setRemindedAt(t.remindedAt);
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load responses.");
      });
  }, [me, id, router, setError]);

  const divisions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) if (r.divisionId) m.set(r.divisionId, r.detail.split(" · ")[0]!);
    return [...m];
  }, [rows]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const f = info?.form;
  const inDiv = (rows ?? []).filter((r) => !division || r.divisionId === division);
  const done = inDiv.filter((r) => r.done);
  const missing = inDiv.filter((r) => !r.done);
  const shown = show === "done" ? done : show === "missing" ? missing : inDiv;

  async function remind() {
    setNote(null);
    const r = await run(() => api.post<{ people: number; emails: number }>(`/admin/forms/${id}/remind`, {}));
    if (r) {
      setRemindedAt(new Date().toISOString());
      setNote(`Reminder emailed to ${r.emails} ${r.emails === 1 ? "person" : "people"} (${r.people} still to complete).`);
    }
  }

  return (
    <main className="page">
      <p>
        <Link href="/admin/forms">← Waivers &amp; forms</Link>
      </p>
      {!f ? (
        <>
          <ErrorAlert error={error} />
          <p className="muted">Loading…</p>
        </>
      ) : (
        <>
          <div className="games-head">
            <div>
              <h1 style={{ margin: 0 }}>{f.title}</h1>
              <p className="muted" style={{ margin: "4px 0 0" }}>
                {AUDIENCE[f.audience]} · {f.required ? "required" : "optional"} · version {f.version}
                {f.dueDate ? ` · complete by ${new Date(`${f.dueDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}
                {f.status !== "live" ? ` · ${f.status}` : ""}
              </p>
            </div>
            <div className="chip-picks">
              <Link className="btn ghost small" href={`/admin/forms/${id}`}>
                Edit
              </Link>
              <a className="btn ghost small" href={`/api/v1/admin/forms/${id}/export.csv`}>
                Download (spreadsheet)
              </a>
            </div>
          </div>
          <ErrorAlert error={error} />
          {note && (
            <div className="alert ok" role="status">
              {note}
            </div>
          )}

          <div className="grid stats3" style={{ margin: "16px 0" }}>
            <div className="card stat">
              <span className="muted">Done</span>
              <strong>{done.length}</strong>
            </div>
            <div className="card stat">
              <span className="muted">Not done yet</span>
              <strong style={{ color: "var(--gold)" }}>{missing.length}</strong>
            </div>
            <div className="card stat">
              {missing.length === 0 && rows ? (
                <span className="muted">Everyone has completed it. Nothing to remind.</span>
              ) : f.askExisting && f.status === "live" ? (
                <>
                  <button type="button" className="btn" disabled={busy || missing.length === 0} onClick={remind}>
                    {busy ? "Sending…" : `Email a reminder to the ${missing.length}`}
                  </button>
                  <span className="muted">{remindedAt ? `Last reminder: ${fmt(remindedAt)}. They also see it on My account.` : "They also see it on My account."}</span>
                </>
              ) : (
                <span className="muted">
                  Reminders: turn on “Also ask people who already signed up” in <Link href={`/admin/forms/${id}`}>Edit</Link>
                  {f.status !== "live" ? " and publish the form" : ""}.
                </span>
              )}
            </div>
          </div>

          <section className="card">
            <div className="chip-picks" style={{ marginBottom: 12 }}>
              {(
                [
                  ["missing", `Not done (${missing.length})`],
                  ["done", `Done (${done.length})`],
                  ["all", "All"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" className={`btn small ${show === k ? "" : "ghost"}`} aria-pressed={show === k} onClick={() => setShow(k)}>
                  {label}
                </button>
              ))}
              {divisions.length > 1 && (
                <label className="inline" style={{ marginLeft: "auto" }}>
                  Division
                  <select value={division} onChange={(e) => setDivision(e.target.value)}>
                    <option value="">All divisions</option>
                    {divisions.map(([dId, name]) => (
                      <option key={dId} value={dId}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {!rows ? (
              <p className="muted">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="muted">{show === "missing" ? "Everyone has completed it." : "Nobody yet."}</p>
            ) : (
              <div className="table-wrap">
                <table className="simple stack">
                  <thead>
                    <tr>
                      <th>{f.audience === "player" ? "Player" : "Name"}</th>
                      <th>{f.audience === "player" ? "Division · team" : "Role"}</th>
                      <th>{f.audience === "player" ? "Parents" : "Contact"}</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.subjectId}>
                        <td data-label="">
                          <strong>{r.name}</strong>
                        </td>
                        <td data-label="">{r.detail}</td>
                        <td data-label="" className="muted">
                          {r.contacts}
                        </td>
                        <td data-label="Status">
                          {r.response ? (
                            <span className={`status ${r.response.agreed ? "ok" : "muted"}`}>
                              {r.response.agreed ? "Signed" : "Declined"} {fmt(r.response.signedAt)}
                            </span>
                          ) : (
                            <span className="status warn">Not done</span>
                          )}
                        </td>
                        <td data-label="" style={{ textAlign: "right" }}>
                          {r.response && (
                            <button type="button" className="btn ghost small" onClick={() => setOpen(r)}>
                              View
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {open?.response && f && (
        <Modal open title={`${f.title}: ${open.name}`} onClose={() => setOpen(null)}>
          <dl className="kv">
            <dt>Signed by</dt>
            <dd>{open.response.signerName}</dd>
            <dt>When</dt>
            <dd>{fmt(open.response.signedAt)}</dd>
            <dt>Version</dt>
            <dd>{open.response.version}</dd>
            <dt>Agreed</dt>
            <dd>{open.response.agreed ? "Yes" : "No"}</dd>
            {f.questions.map((q) => (
              <div key={q.id} style={{ display: "contents" }}>
                <dt>{q.label}</dt>
                <dd>{open.response!.answers[q.id] || "—"}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}
    </main>
  );
}
