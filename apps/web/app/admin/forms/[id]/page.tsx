"use client";

/** Admin: add or edit a waiver or form (/admin/forms/new or /admin/forms/<id>). */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { FormBlock, emptyValue, type FormQuestion, type FormValue } from "@/components/form-fields";
import { Modal } from "@/components/modal";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { AUDIENCE, type Audience } from "@/lib/forms";

interface Draft {
  title: string;
  audience: Audience;
  divisionIds: string[];
  required: boolean;
  askExisting: boolean;
  dueDate: string;
  body: string;
  questions: (Omit<FormQuestion, "id"> & { id?: string; key: string })[];
}
interface Loaded {
  form: { id: string; status: "draft" | "live" | "archived"; version: number; legacySlug: string | null } & Omit<Draft, "questions" | "dueDate"> & {
      dueDate: string | null;
      questions: FormQuestion[];
    };
  versions: { version: number; resign: boolean; createdAt: string }[];
  responses: number;
}

const TYPES: [FormQuestion["type"], string][] = [
  ["short", "Short answer"],
  ["long", "Long answer"],
  ["yesno", "Yes / No"],
  ["choice", "Choose one"],
  ["date", "Date"],
  ["phone", "Phone"],
];

const TEMPLATES: Record<string, { title: string; body: string }> = {
  conduct: {
    title: "Code of conduct",
    body: "As a family in the league, we agree to:\n\n- [YOUR LEAGUE'S CODE OF CONDUCT: sportsmanship, respect for referees and coaches, sideline behavior]\n- [CONSEQUENCES]",
  },
  concussion: {
    title: "Concussion awareness",
    body: "I have read the concussion information sheet and understand the signs of a concussion. [YOUR LEAGUE'S CONCUSSION POLICY AND RETURN-TO-PLAY RULES]",
  },
  travel: { title: "Travel consent", body: "I give permission for my child to travel with the team to [EVENT] on [DATES]. [YOUR LEAGUE'S CONSENT WORDING]" },
  blank: { title: "", body: "" },
};

let keySeq = 0;
const key = () => `q${++keySeq}`;

export default function FormEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === "new";
  const router = useRouter();
  const { me, loading } = useMe();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [divs, setDivs] = useState<{ id: string; name: string }[]>([]);
  const [someDivs, setSomeDivs] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewValue, setPreviewValue] = useState<FormValue>(emptyValue());
  const [askResign, setAskResign] = useState<null | "live" | "draft">(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api.get<{ items: { id: string; name: string }[] }>("/admin/forms/divisions").then((r) => setDivs(r.items)).catch(() => {});
    if (isNew) {
      setD({ title: "", audience: "player", divisionIds: [], required: true, askExisting: false, dueDate: "", body: "", questions: [] });
      return;
    }
    api
      .get<Loaded>(`/admin/forms/${id}`)
      .then((r) => {
        setLoaded(r);
        setSomeDivs(r.form.divisionIds.length > 0);
        setD({
          title: r.form.title,
          audience: r.form.audience,
          divisionIds: r.form.divisionIds,
          required: r.form.required,
          askExisting: r.form.askExisting,
          dueDate: r.form.dueDate ?? "",
          body: r.form.body,
          questions: r.form.questions.map((q) => ({ ...q, key: key() })),
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load this form.");
      });
  }, [me, id, isNew, router, setError]);

  if (loading || !me || !d) {
    return (
      <main className="page">
        <ErrorAlert error={error} />
        <p className="muted">Loading…</p>
      </main>
    );
  }
  const set = (patch: Partial<Draft>) => {
    setD({ ...d, ...patch });
    setSaved(null);
  };
  const setQ = (i: number, patch: Partial<Draft["questions"][number]>) => set({ questions: d.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const moveQ = (i: number, by: number) => {
    const qs = [...d.questions];
    const [q] = qs.splice(i, 1);
    qs.splice(i + by, 0, q!);
    set({ questions: qs });
  };
  const wordingChanged =
    !!loaded &&
    (loaded.form.title !== d.title ||
      loaded.form.body !== d.body ||
      JSON.stringify(loaded.form.questions.map(({ id: _i, ...q }) => q)) !== JSON.stringify(d.questions.map(({ key: _k, id: _i, ...q }) => q)));

  const payload = (status: "draft" | "live", resign: boolean) => ({
    title: d.title.trim(),
    audience: d.audience,
    divisionIds: d.audience === "player" && someDivs ? d.divisionIds : [],
    required: d.required,
    askExisting: d.askExisting,
    dueDate: d.dueDate || null,
    body: d.body,
    questions: d.questions.map(({ key: _k, ...q }) => ({ ...q, options: q.type === "choice" ? (q.options ?? []).filter((o) => o.trim()) : undefined })),
    resign,
    status,
  });

  async function save(status: "draft" | "live", resign = false) {
    setAskResign(null);
    if (isNew) {
      const r = await run(() => api.post<{ id: string; reminded: { emails: number } | null }>("/admin/forms", payload(status, false)));
      if (r) router.replace(`/admin/forms/${r.id}?saved=${status}`);
      return;
    }
    const r = await run(() => api.put<{ version: number; newVersion: boolean; reminded: { emails: number } | null }>(`/admin/forms/${id}`, payload(status, resign)));
    if (!r) return;
    const fresh = await api.get<Loaded>(`/admin/forms/${id}`);
    setLoaded(fresh);
    setD((cur) => cur && { ...cur, questions: fresh.form.questions.map((q) => ({ ...q, key: key() })) });
    setSaved(
      [
        status === "live" ? "Saved and live." : "Saved as a draft.",
        r.newVersion ? `This is version ${r.version}.` : "",
        r.reminded?.emails ? `Emailed ${r.reminded.emails} ${r.reminded.emails === 1 ? "person" : "people"} who still need to complete it.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  /** Changed wording on a form people have signed: ask whether they must sign again. */
  const trySave = (status: "draft" | "live") => (wordingChanged && (loaded?.responses ?? 0) > 0 ? setAskResign(status) : save(status));

  async function archive(archived: boolean) {
    if (archived && !window.confirm("Archive this form? Nobody will be asked to complete it anymore. Every signature is kept.")) return;
    if ((await run(() => api.post(`/admin/forms/${id}/archive`, { archived }))) !== undefined) router.replace("/admin/forms");
  }

  const status = loaded?.form.status ?? "draft";
  const previewForm = { id: "preview", title: d.title || "Untitled", required: d.required, version: 1, body: d.body, questions: d.questions.map((q) => ({ ...q, id: q.id ?? q.key })) };

  return (
    <main className="page" style={{ maxWidth: 1280 }}>
      <p>
        <Link href="/admin/forms">← Waivers &amp; forms</Link>
      </p>
      <h1>{isNew ? "Add a waiver or form" : d.title || "Edit form"}</h1>
      {!isNew && (
        <p className="muted">
          {status === "live" ? "Live" : status === "draft" ? "Draft (nobody sees it yet)" : "Archived"} · version {loaded?.form.version} · {loaded?.responses ?? 0}{" "}
          {loaded?.responses === 1 ? "response" : "responses"} · <Link href={`/admin/forms/${id}/responses`}>Who&apos;s signed</Link>
        </p>
      )}
      <ErrorAlert error={error} />
      {saved && (
        <div className="alert ok" role="status">
          {saved}
        </div>
      )}

      <div className="form-editor">
        <section className="card stack">
          <label>
            Name
            <input type="text" value={d.title} maxLength={120} required onChange={(e) => set({ title: e.target.value })} />
          </label>
          {isNew ? (
            <fieldset className="radio-set">
              <legend>Who completes it</legend>
              {(Object.keys(AUDIENCE) as Audience[]).map((a) => (
                <label key={a} className="check">
                  <input type="radio" name="audience" checked={d.audience === a} onChange={() => set({ audience: a })} />
                  {a === "player" ? "Parents, once per player" : AUDIENCE[a]}
                </label>
              ))}
            </fieldset>
          ) : (
            <div className="radio-set">
              <strong>Who completes it</strong>
              <span>{d.audience === "player" ? "Parents, once per player" : AUDIENCE[d.audience]}</span>
              <span className="muted">This can't change once a form is made.</span>
            </div>
          )}
          {d.audience === "player" && (
            <fieldset className="radio-set">
              <legend>Divisions</legend>
              <label className="check">
                <input type="radio" name="divs" checked={!someDivs} onChange={() => setSomeDivs(false)} />
                All divisions
              </label>
              <label className="check">
                <input type="radio" name="divs" checked={someDivs} onChange={() => setSomeDivs(true)} />
                Only some
              </label>
              {someDivs && (
                <div className="chip-picks">
                  {divs.map((v) => {
                    const on = d.divisionIds.includes(v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`btn small ${on ? "" : "ghost"}`}
                        aria-pressed={on}
                        onClick={() => set({ divisionIds: on ? d.divisionIds.filter((x) => x !== v.id) : [...d.divisionIds, v.id] })}
                      >
                        {v.name}
                      </button>
                    );
                  })}
                  {divs.length === 0 && <span className="muted">No divisions in the current season yet.</span>}
                </div>
              )}
            </fieldset>
          )}
          <fieldset className="radio-set">
            <legend>Required?</legend>
            <label className="check">
              <input type="radio" name="req" checked={d.required} onChange={() => set({ required: true })} />
              Required to take part
            </label>
            <label className="check">
              <input type="radio" name="req" checked={!d.required} onChange={() => set({ required: false })} />
              Optional (their yes / no answer is saved)
            </label>
          </fieldset>
          <fieldset className="radio-set">
            <legend>When</legend>
            <span className="muted">Always shown when someone signs up.</span>
            <label className="check">
              <input type="checkbox" checked={d.askExisting} onChange={(e) => set({ askExisting: e.target.checked })} />
              Also ask people who already signed up (shows on My account and emails them when it goes live)
            </label>
            {d.askExisting && (
              <label>
                Complete by (optional)
                <input type="date" value={d.dueDate} onChange={(e) => set({ dueDate: e.target.value })} style={{ maxWidth: 220 }} />
              </label>
            )}
          </fieldset>
        </section>

        <div className="stack">
          <section className="card stack">
            <div className="games-head" style={{ marginBottom: 0 }}>
              <h2 style={{ margin: 0 }}>Wording</h2>
              {isNew && (
                <label className="inline">
                  Start from{" "}
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const t = TEMPLATES[e.target.value];
                      if (t) set({ title: d.title || t.title, body: t.body });
                    }}
                  >
                    <option value="">Choose…</option>
                    <option value="conduct">Code of conduct</option>
                    <option value="concussion">Concussion awareness</option>
                    <option value="travel">Travel consent</option>
                    <option value="blank">Blank</option>
                  </select>
                </label>
              )}
            </div>
            <textarea rows={8} value={d.body} aria-label="Wording" onChange={(e) => set({ body: e.target.value })} />
            <span className="muted editor-help">## Heading · **bold** · - bullet list · [link text](/faq)</span>
            {loaded?.form.legacySlug && <span className="muted">Moved here from the original registration waivers. Past signatures are kept as version 1.</span>}
          </section>

          <section className="card stack">
            <h2 style={{ margin: 0 }}>Questions (optional)</h2>
            {d.questions.length === 0 && <p className="muted" style={{ margin: 0 }}>None: people just read and agree.</p>}
            {d.questions.map((q, i) => (
              <div key={q.key} className="q-edit">
                <div className="form-row">
                  <label>
                    Question
                    <input type="text" value={q.label} maxLength={200} onChange={(e) => setQ(i, { label: e.target.value })} />
                  </label>
                  <label>
                    Answer type
                    <select value={q.type} onChange={(e) => setQ(i, { type: e.target.value as FormQuestion["type"] })}>
                      {TYPES.map(([t, label]) => (
                        <option key={t} value={t}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {q.type === "choice" && (
                  <label>
                    Choices (one per line)
                    <textarea rows={3} value={(q.options ?? []).join("\n")} onChange={(e) => setQ(i, { options: e.target.value.split("\n") })} />
                  </label>
                )}
                <div className="q-edit-bar">
                  <label className="check">
                    <input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} />
                    Required
                  </label>
                  <span style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => moveQ(i, -1)} aria-label="Move up">
                      ↑
                    </button>
                    <button type="button" className="btn ghost small" disabled={i === d.questions.length - 1} onClick={() => moveQ(i, 1)} aria-label="Move down">
                      ↓
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => set({ questions: d.questions.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  </span>
                </div>
              </div>
            ))}
            <div className="chip-picks">
              <span style={{ fontWeight: 700 }}>Add a question:</span>
              {TYPES.map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  className="btn ghost small"
                  onClick={() => set({ questions: [...d.questions, { key: key(), label: "", type: t, required: true, ...(t === "choice" ? { options: ["", ""] } : {}) }] })}
                >
                  + {label}
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Every form ends with the person typing their full name as their signature, with the date.
            </p>
          </section>

          <div className="chip-picks">
            <button type="button" className="btn" disabled={busy || !d.title.trim()} onClick={() => trySave("live")}>
              {busy ? "Saving…" : status === "live" ? "Save" : "Publish"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setPreview(true)}>
              Preview
            </button>
            {status !== "live" && (
              <button type="button" className="btn ghost" disabled={busy || !d.title.trim()} onClick={() => trySave("draft")}>
                Save as draft
              </button>
            )}
            {status === "live" && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => trySave("draft")}>
                Unpublish
              </button>
            )}
            {!isNew && status !== "archived" && (
              <button type="button" className="btn danger small" disabled={busy} onClick={() => archive(true)}>
                Archive
              </button>
            )}
            {status === "archived" && (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => archive(false)}>
                Bring back (as a draft)
              </button>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <Modal open title="Preview" onClose={() => setPreview(false)}>
          <p className="muted">What people see{d.audience === "player" ? " in the registration Waivers step" : ""}.</p>
          <FormBlock form={previewForm} value={previewValue} onChange={setPreviewValue} scope="preview-" />
        </Modal>
      )}
      {askResign && (
        <Modal open title="Must people sign again?" onClose={() => setAskResign(null)}>
          <p>
            You changed the wording or questions. {loaded?.responses} {loaded?.responses === 1 ? "person has" : "people have"} completed this form. What they signed is kept
            either way.
          </p>
          <div className="stack">
            <button type="button" className="btn" onClick={() => save(askResign, false)}>
              No: small fix, earlier signatures still count
            </button>
            <button type="button" className="btn ghost" onClick={() => save(askResign, true)}>
              Yes: everyone signs the new version
            </button>
          </div>
          {!d.askExisting && (
            <p className="muted">
              To have people already signed up re-sign from My account, also turn on “Also ask people who already signed up”.
            </p>
          )}
        </Modal>
      )}
    </main>
  );
}
