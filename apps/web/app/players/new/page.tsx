"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PlayerDocuments } from "@/components/doc-upload";
import { useAction } from "@/components/form";
import { EMPTY_PLAYER, PlayerForm, readPlayerForm } from "@/components/player-form";
import { api } from "@/lib/api";
import { useMe } from "@/lib/use-me";

function NewPlayer() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const { me, loading } = useMe();
  const { busy, error, run } = useAction();
  // After saving: the child's documents (optional here; required before paying for a registration).
  const [saved, setSaved] = useState<{ id: string; firstName: string } | null>(null);
  const [complete, setComplete] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = readPlayerForm(e.currentTarget);
    const res = await run(() => api.post<{ player: { id: string; firstName: string } }>("/players", values));
    if (!res) return;
    // Offer the uploads only while they're switched on.
    const docs = await api.get<{ required: boolean }>(`/players/${res.player.id}/documents`).catch(() => ({ required: false }));
    if (!docs.required) return router.push(next === "register" ? `/register?player=${res.player.id}` : "/dashboard");
    setSaved({ id: res.player.id, firstName: res.player.firstName });
    window.scrollTo({ top: 0 });
  }
  const done = () => router.push(next === "register" && saved ? `/register?player=${saved.id}` : "/dashboard");

  if (saved) {
    return (
      <main className="page" style={{ maxWidth: 900 }}>
        <p>
          <Link href="/dashboard">← My account</Link>
        </p>
        <h1>Documents for {saved.firstName}</h1>
        <div className="alert ok" role="status">
          {saved.firstName} is saved.
        </div>
        <section className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            The league needs a birth certificate, a medical insurance card and a headshot for every player. Add them now, or skip and
            add them when you register; they&apos;re required before paying. Only league admins see the birth certificate and insurance
            card; your child&apos;s coaches see the headshot.
          </p>
          <PlayerDocuments playerId={saved.id} onChange={setComplete} />
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginTop: 20 }}>
            <button className="btn" onClick={done}>
              {next === "register" ? "Continue to registration" : "Done"}
            </button>
            {!complete && <span className="hint">You can add the rest later.</span>}
          </div>
        </section>
      </main>
    );
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Add a player</h1>
      <p className="muted">Add each child once; you can register them for any season from your account.</p>
      <PlayerForm initial={EMPTY_PLAYER} onSubmit={onSubmit} busy={busy} error={error} submitLabel="Save player" />
    </main>
  );
}

export default function NewPlayerPage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <NewPlayer />
    </Suspense>
  );
}
