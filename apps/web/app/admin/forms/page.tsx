"use client";

/** Admin: the Waivers & forms library. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { AUDIENCE, type Audience } from "@/lib/forms";
import { useMe } from "@/lib/use-me";


interface Row {
  id: string;
  title: string;
  audience: Audience;
  divisions: string[];
  required: boolean;
  status: "draft" | "live" | "archived";
  askExisting: boolean;
  dueDate: string | null;
  version: number;
  questions: number;
  done: number;
  total: number;
}

const STATUS = { live: ["Live", "ok"], draft: ["Draft", "warn"], archived: ["Archived", "muted"] } as const;

export default function AdminFormsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [show, setShow] = useState<Audience | "all" | "archived">("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    if (!me.permissions.includes("forms.manage")) {
      router.replace("/admin");
      return;
    }
    api
      .get<{ items: Row[] }>("/admin/forms")
      .then((r) => setRows(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "SESSION_IDLE") router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load forms.");
      });
  }, [me, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const active = rows?.filter((r) => r.status !== "archived") ?? [];
  const shown = rows?.filter((r) => (show === "archived" ? r.status === "archived" : r.status !== "archived" && (show === "all" || r.audience === show))) ?? [];
  const count = (a: Audience) => active.filter((r) => r.audience === a).length;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <div className="games-head">
        <div>
          <h1 style={{ margin: 0 }}>Waivers &amp; forms</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            What families, coaches and referees agree to or fill in, and who has done it.
          </p>
        </div>
        <Link className="btn" href="/admin/forms/new">
          + Add a waiver or form
        </Link>
      </div>
      <ErrorAlert error={error} />
      <div className="toggle-row" role="group" aria-label="Show" style={{ margin: "16px 0" }}>
        {(
          [
            ["all", `All (${active.length})`],
            ["player", `Families (${count("player")})`],
            ["staff", `Coaches & staff (${count("staff")})`],
            ["referee", `Referees (${count("referee")})`],
            ["archived", "Archived"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={`btn small ${show === k ? "" : "ghost"}`} aria-pressed={show === k} onClick={() => setShow(k)}>
            {label}
          </button>
        ))}
      </div>
      <section className="card">
        {!rows ? (
          <p className="muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Waiver or form</th>
                  <th>Who completes it</th>
                  <th>Divisions</th>
                  <th>Required</th>
                  <th>Completed</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td data-label="" style={{ minWidth: 220 }}>
                      <Link href={`/admin/forms/${r.id}/responses`}>
                        <strong>{r.title}</strong>
                      </Link>
                      <br />
                      <span className="muted">
                        Version {r.version}
                        {r.questions ? ` · ${r.questions} question${r.questions === 1 ? "" : "s"}` : ""}
                        {r.askExisting ? " · asks people already signed up" : ""}
                      </span>
                    </td>
                    <td data-label="Who">{AUDIENCE[r.audience]}</td>
                    <td data-label="Divisions">{r.audience !== "player" ? "—" : r.divisions.length ? r.divisions.join(", ") : "All"}</td>
                    <td data-label="Required">{r.required ? "Required" : "Optional"}</td>
                    <td data-label="Completed">
                      {r.status === "archived" ? (
                        "—"
                      ) : (
                        <Link className="progress-cell" href={`/admin/forms/${r.id}/responses`} aria-label={`${r.done} of ${r.total} completed: see who`}>
                          {r.done} of {r.total}
                          <span className="progress" aria-hidden="true">
                            <span style={{ width: `${r.total ? Math.round((r.done / r.total) * 100) : 0}%` }} />
                          </span>
                        </Link>
                      )}
                    </td>
                    <td data-label="Status">
                      <span className={`status ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                    </td>
                    <td data-label="" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Link className="btn small" href={`/admin/forms/${r.id}`}>
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted">
        Every signature keeps the exact wording that was signed, the name typed, and the date. Changing the wording makes a new version; you choose whether people
        must sign again.
      </p>
    </main>
  );
}
