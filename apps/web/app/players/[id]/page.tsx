"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { PlayerForm, readPlayerForm, type PlayerValues } from "@/components/player-form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

interface RegRow {
  playerId: string;
  status: string;
}

export default function EditPlayerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [initial, setInitial] = useState<PlayerValues | null>(null);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!me) return;
    Promise.all([
      api.get<{ player: Omit<PlayerValues, "medical">; medical: PlayerValues["medical"] | null }>(`/players/${id}`),
      api.get<{ items: RegRow[] }>("/registrations"),
    ])
      .then(([p, r]) => {
        setInitial({ ...p.player, medical: p.medical ?? { emergencyContactName: "", emergencyContactPhone: "" } });
        setLocked(r.items.some((x) => x.playerId === id && ["processing", "paid", "approved"].includes(x.status)));
      })
      .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 ? "Player not found." : "Couldn't load this player."));
  }, [me, id]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if ((await run(() => api.patch(`/players/${id}`, readPlayerForm(e.currentTarget)))) !== undefined) router.push("/dashboard");
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Edit player</h1>
      <ErrorAlert error={loadError} />
      {initial ? (
        <PlayerForm initial={initial} onSubmit={onSubmit} busy={busy} error={error} submitLabel="Save changes" lockIdentity={locked} />
      ) : (
        !loadError && <p className="muted">Loading…</p>
      )}
    </main>
  );
}
