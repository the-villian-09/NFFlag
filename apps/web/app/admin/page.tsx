"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { isAdmin, useMe } from "@/lib/use-me";

interface Flag {
  key: string;
  enabled: boolean;
  description: string | null;
}

/** Admin portal home: links to each admin area the user has permission for, plus release switches. */
export default function AdminPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const { error, setError, run } = useAction();
  const canFlags = me?.permissions.includes("platform.flags.manage");

  useEffect(() => {
    if (!me) return;
    if (!isAdmin(me)) {
      router.replace("/dashboard");
      return;
    }
    if (!canFlags) return;
    api
      .get<{ items: Flag[] }>("/admin/flags")
      .then((r) => setFlags(r.items))
      .catch((err) => {
        if (err instanceof ApiError && err.code === "SESSION_IDLE")
          router.replace("/sign-in");
        else setError(err.message);
      });
  }, [me, canFlags, router, setError]);

  async function toggle(flag: Flag) {
    const res = await run(() =>
      api.put<{ flag: Flag }>(`/admin/flags/${flag.key}`, {
        enabled: !flag.enabled,
      }),
    );
    if (res)
      setFlags(
        (list) => list?.map((f) => (f.key === flag.key ? res.flag : f)) ?? null,
      );
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Admin portal</h1>
      <div className="grid">
        {me.permissions.includes("registrations.read") && (
          <div className="card">
            <h2>Registrations</h2>
            <p className="muted">
              Review new registrations, approve or reject, refund, and download
              a spreadsheet.
            </p>
            <Link className="btn small" href="/admin/registrations">
              Open registrations
            </Link>
          </div>
        )}
        {me.permissions.includes("registrations.read") && (
          <div className="card">
            <h2>Waitlist</h2>
            <p className="muted">
              Families waiting for a spot in full divisions, and open offers.
            </p>
            <Link className="btn small" href="/admin/waitlist">
              Open waitlist
            </Link>
          </div>
        )}
        {me.permissions.includes("staff.applications.review") && (
          <div className="card">
            <h2>Coaches & staff</h2>
            <p className="muted">
              Head coach, assistant coach and team mom applications, background
              checks and approvals.
            </p>
            <Link className="btn small" href="/admin/staff">
              Review applications
            </Link>
          </div>
        )}
        {me.permissions.includes("platform.admins.manage") && (
          <div className="card">
            <h2>Admins</h2>
            <p className="muted">
              Add or remove people who help run the league. Only you can change
              payments setup.
            </p>
            <Link className="btn small" href="/admin/admins">
              Manage admins
            </Link>
          </div>
        )}
        {me.permissions.includes("teams.manage") && (
          <div className="card">
            <h2>Teams & draft</h2>
            <p className="muted">
              Create teams, assign coaches and team moms, run the draft and
              publish rosters.
            </p>
            <OffNote flags={flags} k="r3.teams_draft" what="Teams and rosters" />
            <Link className="btn small" href="/admin/teams">
              Teams & draft
            </Link>
          </div>
        )}
        {me.permissions.includes("games.manage") && (
          <div className="card">
            <h2>Schedule & scores</h2>
            <p className="muted">Add games or import a spreadsheet, reschedule or cancel, and enter final scores for the standings.</p>
            <OffNote flags={flags} k="r4.games" what="Games and standings" />
            <Link className="btn small" href="/admin/schedule">
              Schedule
            </Link>
          </div>
        )}
        {me.permissions.includes("announcements.send") && (
          <div className="card">
            <h2>Announcements</h2>
            <p className="muted">Email every family this season, one division, or one team.</p>
            <OffNote flags={flags} k="r4.announcements" what="Coach announcements" />
            <Link className="btn small" href="/admin/announcements">
              Send an announcement
            </Link>
          </div>
        )}
        {me.permissions.includes("seasons.read") && (
          <div className="card">
            <h2>Seasons and divisions</h2>
            <p className="muted">
              Registration dates, divisions, age ranges, prices and capacity.
            </p>
            <Link className="btn small" href="/admin/seasons">
              Set up seasons
            </Link>
          </div>
        )}
        {me.permissions.includes("payments.read") && (
          <div className="card">
            <h2>Payments</h2>
            <p className="muted">
              Connect or disconnect Square, and choose who pays the card fee.
            </p>
            <Link className="btn small" href="/admin/payments">
              Payment settings
            </Link>
          </div>
        )}
        {me.permissions.includes("content.manage") && (
          <div className="card">
            <h2>Site content</h2>
            <p className="muted">
              Edit public pages, the announcement banner and contact details,
              and read contact-form messages.
            </p>
            <Link className="btn small" href="/admin/content">
              Manage content
            </Link>
          </div>
        )}
      </div>

      {canFlags && (
        <section className="card" style={{ marginTop: 24 }}>
          <h2>Release switches</h2>
          <p className="muted">
            Turn each release on when it's been accepted. Every change is
            recorded in the audit log.
          </p>
          <ErrorAlert error={error} />
          {!flags ? (
            <p className="muted">Loading…</p>
          ) : (
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.key}>
                    <td data-label="">
                      {f.description ?? f.key}
                      <br />
                      <code className="muted">{f.key}</code>
                    </td>
                    <td data-label="Status">{f.enabled ? "On" : "Off"}</td>
                    <td data-label="">
                      <button className="btn ghost" onClick={() => toggle(f)}>
                        Turn {f.enabled ? "off" : "on"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}

/** Shown on a card when its release switch is off (only the Super Admin sees switches). */
function OffNote({ flags, k, what }: { flags: Flag[] | null; k: string; what: string }) {
  const f = flags?.find((x) => x.key === k);
  if (!f || f.enabled) return null;
  return (
    <p className="muted" style={{ margin: "0 0 12px", fontSize: 15 }}>
      <span className="status warn">Off</span> {what} are hidden from families and coaches. Turn on <code>{k}</code> under Release switches when ready.
    </p>
  );
}
