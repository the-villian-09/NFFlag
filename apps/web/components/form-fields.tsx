"use client";

/**
 * One waiver or form from the Waivers & forms library: its wording, its
 * questions, and the agreement (a checkbox when required; yes/no when
 * optional). Used in registration, the coach & staff application, and
 * My account → Forms to complete.
 */
import { Markdown } from "@/components/markdown";

export interface FormQuestion {
  id: string;
  label: string;
  type: "short" | "long" | "yesno" | "choice" | "date" | "phone";
  required: boolean;
  options?: string[];
  help?: string;
}

export interface PublicForm {
  id: string;
  title: string;
  required: boolean;
  version: number;
  body: string;
  questions: FormQuestion[];
  dueDate?: string | null;
  /** Player forms: divisions it applies to (empty = all). */
  divisionIds?: string[];
}

export interface FormValue {
  /** null: not answered yet (optional forms). */
  agreed: boolean | null;
  answers: Record<string, string>;
}

export const emptyValue = (): FormValue => ({ agreed: null, answers: {} });

/** Every required form agreed to and every required question answered. */
export function formsReady(fs: PublicForm[], values: Record<string, FormValue>) {
  return fs.every((f) => {
    const v = values[f.id];
    if (f.required && !v?.agreed) return false;
    if (!v?.agreed) return true;
    return f.questions.every((q) => !q.required || (v.answers[q.id] ?? "").trim());
  });
}

/** What the API takes: one entry per form the person answered. */
export const toPayload = (fs: PublicForm[], values: Record<string, FormValue>) =>
  fs.flatMap((f) => {
    const v = values[f.id];
    if (!v || v.agreed === null) return [];
    return [{ formId: f.id, agreed: v.agreed, answers: v.agreed ? v.answers : {} }];
  });

function Question({ q, value, onChange, name }: { q: FormQuestion; value: string; onChange: (v: string) => void; name: string }) {
  const label = (
    <>
      {q.label}
      {!q.required && <span className="muted"> (optional)</span>}
    </>
  );
  if (q.type === "yesno" || q.type === "choice") {
    const opts = q.type === "yesno" ? [["yes", "Yes"], ["no", "No"]] : (q.options ?? []).map((o) => [o, o]);
    return (
      <fieldset className="form-q">
        <legend>{label}</legend>
        {q.help && <span className="muted">{q.help}</span>}
        <div className="form-q-options">
          {opts.map(([v, text]) => (
            <label key={v} className="check">
              <input type="radio" name={name} value={v} checked={value === v} required={q.required} onChange={() => onChange(v!)} />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <label className="form-q">
      {label}
      {q.help && <span className="muted">{q.help}</span>}
      {q.type === "long" ? (
        <textarea rows={3} value={value} maxLength={2000} required={q.required} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          type={q.type === "date" ? "date" : q.type === "phone" ? "tel" : "text"}
          value={value}
          maxLength={300}
          required={q.required}
          autoComplete={q.type === "phone" ? "tel" : "off"}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export function FormBlock({ form, value, onChange, scope = "" }: { form: PublicForm; value: FormValue; onChange: (v: FormValue) => void; scope?: string }) {
  const set = (patch: Partial<FormValue>) => onChange({ ...value, ...patch });
  const showQuestions = form.questions.length > 0 && (form.required || value.agreed === true);
  return (
    <div className="waiver">
      <strong style={{ fontSize: 20, color: "#fff" }}>
        {form.title}
        {!form.required && <span className="muted" style={{ fontSize: 15, fontWeight: 600 }}> · optional</span>}
      </strong>
      <Markdown source={form.body} />
      {showQuestions && (
        <div className="form-qs">
          {form.questions.map((q) => (
            <Question
              key={q.id}
              q={q}
              name={`${scope}${form.id}-${q.id}`}
              value={value.answers[q.id] ?? ""}
              onChange={(v) => set({ answers: { ...value.answers, [q.id]: v } })}
            />
          ))}
        </div>
      )}
      {form.required ? (
        <label className="check">
          <input type="checkbox" checked={value.agreed === true} onChange={(e) => set({ agreed: e.target.checked })} />I have read and agree to the{" "}
          {form.title.toLowerCase()}.
        </label>
      ) : (
        <div className="form-q-options" role="radiogroup" aria-label={form.title}>
          <label className="check">
            <input type="radio" name={`${scope}${form.id}-agree`} checked={value.agreed === true} onChange={() => set({ agreed: true })} />
            Yes, I agree
          </label>
          <label className="check">
            <input type="radio" name={`${scope}${form.id}-agree`} checked={value.agreed === false} onChange={() => set({ agreed: false })} />
            No thanks
          </label>
        </div>
      )}
    </div>
  );
}
