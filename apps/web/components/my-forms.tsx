"use client";

/**
 * My account: forms the league added after someone signed up ("Action
 * needed"), and every waiver and form they've completed.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Modal } from "@/components/modal";
import type { FormQuestion, PublicForm } from "@/components/form-fields";
import { api } from "@/lib/api";

export interface Outstanding {
  form: PublicForm;
  subjectType: "registration" | "staff_application" | "referee_application";
  subjectId: string;
  label: string;
}
interface Completed {
  id: string;
  title: string;
  body: string;
  version: number;
  agreed: boolean;
  signerName: string;
  signedAt: string;
  answers: Record<string, string>;
  questions: FormQuestion[];
}

export const formLink = (o: Outstanding) => `/forms/${o.form.id}?for=${o.subjectType}:${o.subjectId}`;

const fmtDue = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtSigned = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

export function useMyForms(enabled = true) {
  const [data, setData] = useState<{ outstanding: Outstanding[]; completed: Completed[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api
      .get<{ outstanding: Outstanding[]; completed: Completed[] }>("/me/forms")
      .then(setData)
      .catch(() => setData({ outstanding: [], completed: [] }));
  }, [enabled]);
  return data;
}

/** Shown at the top of My account when something needs doing. */
export function ActionNeeded({ items }: { items: Outstanding[] }) {
  if (!items.length) return null;
  const due = items.map((i) => i.form.dueDate).filter((d): d is string => !!d).sort()[0];
  return (
    <section id="forms" className="card action-needed" aria-labelledby="action-needed-title">
      <h2 id="action-needed-title">Action needed</h2>
      <p>
        The league needs {items.length === 1 ? "this form" : `these ${items.length} forms`} completed{due ? ` by ${fmtDue(due)}` : ""}.
      </p>
      <ul className="action-list">
        {items.map((i) => (
          <li key={`${i.form.id}:${i.subjectId}`}>
            <span>
              <strong>{i.form.title}</strong>
              <span className="muted">{i.label}</span>
            </span>
            <Link className="btn small" href={formLink(i)}>
              Complete
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Everything completed, with the wording and answers as signed. */
export function SignedFormsCard({ items }: { items: Completed[] }) {
  const [open, setOpen] = useState<Completed | null>(null);
  if (!items.length) return null;
  return (
    <section className="card">
      <h2>Signed waivers &amp; forms</h2>
      <ul className="action-list">
        {items.slice(0, 20).map((c) => (
          <li key={c.id}>
            <span>
              <strong>{c.title}</strong>
              <span className="muted">
                {c.agreed ? "Signed" : "Declined"} {fmtSigned(c.signedAt)} by {c.signerName}
              </span>
            </span>
            <button type="button" className="btn ghost small" onClick={() => setOpen(c)}>
              View
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Modal open title={open.title} onClose={() => setOpen(null)}>
          <p className="muted">
            {open.agreed ? "Signed" : "Declined"} {fmtSigned(open.signedAt)} by {open.signerName} · version {open.version}
          </p>
          <Markdown source={open.body} />
          {open.questions.length > 0 && (
            <dl className="kv">
              {open.questions.map((q) => (
                <div key={q.id} style={{ display: "contents" }}>
                  <dt>{q.label}</dt>
                  <dd>{open.answers[q.id] || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </Modal>
      )}
    </section>
  );
}
