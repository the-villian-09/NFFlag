"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError, authApi } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/use-me";

interface Household {
  id: string;
  displayName: string;
  phone: string | null;
}

/** Parent dashboard. R1b adds children, registrations and payment status here. */
export default function DashboardPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [household, setHousehold] = useState<Household | null | undefined>(undefined);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api
      .get<{ household: Household }>("/households/me")
      .then((r) => setHousehold(r.household))
      .catch((err) => setHousehold(err instanceof ApiError && err.status === 404 ? null : undefined));
  }, [me]);

  async function createHousehold(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await run(() =>
      api.post<{ household: Household }>("/households", {
        displayName: String(f.get("displayName")),
        phone: String(f.get("phone") || "") || undefined,
      }),
    );
    if (res) setHousehold(res.household);
  }

  async function signOut() {
    await authApi.signOut();
    router.replace("/");
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Welcome, {me.user.name.split(" ")[0]}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {isAdmin(me) && (
            <Link className="btn accent" href="/admin">
              Admin portal
            </Link>
          )}
          <button className="btn ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 24 }}>
        <section className="card">
          <h2>Your family</h2>
          {household === undefined && <p className="muted">Loading…</p>}
          {household === null && (
            <form className="stack" onSubmit={createHousehold}>
              <ErrorAlert error={error} />
              <label>
                Family name (as you'd like it shown)
                <input type="text" name="displayName" required maxLength={120} placeholder="The Smith Family" />
              </label>
              <label>
                Mobile phone
                <input type="text" name="phone" autoComplete="tel" maxLength={32} />
              </label>
              <button className="btn" disabled={busy}>
                Save
              </button>
            </form>
          )}
          {household && (
            <p>
              <strong>{household.displayName}</strong>
              {household.phone ? <><br />{household.phone}</> : null}
            </p>
          )}
        </section>
        <section className="card">
          <h2>Registration</h2>
          <p className="muted">You'll add your children and register here when registration opens.</p>
        </section>
      </div>
    </main>
  );
}
