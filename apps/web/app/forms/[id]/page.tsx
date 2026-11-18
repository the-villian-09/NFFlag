"use client";

/** Completing one form from My account (Action needed → Complete). */
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { emptyValue, FormBlock, formsReady, toPayload, type FormValue } from "@/components/form-fields";
import { useMyForms } from "@/components/my-forms";
import { api } from "@/lib/api";
import { useMe } from "@/lib/use-me";

function CompleteForm() {
  const { id } = useParams<{ id: string }>();
  const [subjectType, subjectId] = (useSearchParams().get("for") ?? "").split(":");
  const router = useRouter();
  const { me, loading } = useMe();
  const data = useMyForms(!!me);
  const { busy, error, run } = useAction();
  const [value, setValue] = useState<FormValue>(emptyValue());
  const [signer, setSigner] = useState<string | null>(null);

  if (loading || !me || !data) return <main className="page muted">Loading…</main>;
  const item = data.outstanding.find((o) => o.form.id === id && o.subjectType === subjectType && o.subjectId === subjectId);
  if (!item) {
    return (
      <main className="page">
        <p>
          <Link href="/dashboard">← My account</Link>
        </p>
        <h1>Nothing to complete</h1>
        <p className="muted">This form is already done, or it's no longer needed.</p>
      </main>
    );
  }
  const name = signer ?? me.user.name;
  const ready = formsReady([item.form], { [item.form.id]: value }) && name.trim().length >= 3;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [r] = toPayload([item!.form], { [item!.form.id]: value });
    if (!r) return;
    const ok = await run(() => api.post("/me/forms", { ...r, subjectType, subjectId, signerName: name }));
    if (ok !== undefined) router.push("/dashboard?form=done");
  }

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <p className="game-kicker">For {item.label}</p>
      <h1 style={{ marginTop: 0 }}>{item.form.title}</h1>
      <form className="stack" onSubmit={submit}>
        <FormBlock form={item.form} value={value} onChange={setValue} />
        <label>
          Your full name (electronic signature)
          <input type="text" value={name} onChange={(e) => setSigner(e.target.value)} required minLength={3} maxLength={120} autoComplete="name" />
        </label>
        <span className="muted">Signed today. It stays under My account → Signed waivers &amp; forms.</span>
        <ErrorAlert error={error} />
        <button className="btn" disabled={busy || !ready}>
          {busy ? "Saving…" : item.form.required ? "Sign and submit" : "Save my answer"}
        </button>
      </form>
    </main>
  );
}

export default function CompleteFormPage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <CompleteForm />
    </Suspense>
  );
}
