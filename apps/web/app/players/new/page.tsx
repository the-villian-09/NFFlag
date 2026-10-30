"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAction } from "@/components/form";
import { EMPTY_PLAYER, PlayerForm, readPlayerForm } from "@/components/player-form";
import { api } from "@/lib/api";
import { useMe } from "@/lib/use-me";

function NewPlayer() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const { me, loading } = useMe();
  const { busy, error, run } = useAction();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const res = await run(() => api.post<{ player: { id: string } }>("/players", readPlayerForm(e.currentTarget)));
    if (res) router.push(next === "register" ? `/register?player=${res.player.id}` : "/dashboard");
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
