"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { isAdmin, useMe } from "@/lib/use-me";
import { TeamTools } from "@/components/team-tools";
import { useFlags } from "@/lib/use-flags";

interface Medical {
  allergies: string | null;
  medicalConditions: string | null;
  medications: string | null;
  medicalInstructions: string | null;
  physicianName: string | null;
  physicianPhone: string | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelationship: string | null;
}
interface Row {
  entryId: string;
  playerId: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  birthDate: string;
  shirtSize: string | null;
  householdName: string;
  householdPhone: string | null;
  guardians: { name: string; email: string }[];
  medical: Medical | null;
  photoUrl?: string | null;
}
interface TeamView {
  team: { id: string; name: string; divisionName: string };
  staff: { userId: string; roleKey: string; name: string; email: string }[];
  roster: Row[];
  canSeeMedical: boolean;
}

const ROLE: Record<string, string> = {
  head_coach: "Head coach",
  assistant_coach: "Assistant coach",
  team_manager: "Team mom",
};

/** A coach's or team mom's view of their team: players, parent contacts and (head coach) medical/emergency details. */
export default function MyTeamPage() {
  const { teamId } = useParams<{ teamId: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [v, setV] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flags = useFlags();

  useEffect(() => {
    if (!me) return;
    api
      .get<TeamView>(`/my-teams/${teamId}`)
      .then(setV)
      .catch((err) => {
        if (
          err instanceof ApiError &&
          (err.code === "SESSION_IDLE" || err.status === 401)
        )
          router.replace("/sign-in");
        else
          setError(
            err instanceof ApiError && err.status === 403
              ? "You don't have access to this team."
              : err instanceof Error
                ? err.message
                : "Couldn't load the team.",
          );
      });
  }, [me, teamId, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  if (!v)
    return (
      <main className="page">
        <p>
          <Link href="/dashboard">← My account</Link>
        </p>
        {error ? (
          <ErrorAlert error={error} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );

  const myRole = v.staff.find((s) => s.userId === me.user.id)?.roleKey;
  // Admins see everything; coaches see each tool once its release switch is on.
  const admin = isAdmin(me);
  const on = (key: string) => admin || !!flags?.has(key);
  const canPractice = on("r3.practices") && (myRole === "head_coach" || myRole === "assistant_coach" || admin);
  const canAnnounce = on("r4.announcements") && (!!myRole || admin);
  const emails = [
    ...new Set(v.roster.flatMap((r) => r.guardians.map((g) => g.email))),
  ];
  const flagged = (m: Medical | null) =>
    !!m &&
    !!(
      m.allergies ||
      m.medicalConditions ||
      m.medications ||
      m.medicalInstructions
    );

  return (
    <main className="page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1 style={{ marginBottom: 4 }}>{v.team.name}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {v.team.divisionName} · {v.roster.length} players
      </p>

      <div className="grid">
        <section className="card">
          <h2>Staff</h2>
          <ul className="list">
            {v.staff.map((s) => (
              <li key={s.userId}>
                <span>
                  <span className="who">{s.name}</span>
                  <br />
                  <span className="muted">{ROLE[s.roleKey] ?? s.roleKey}</span>
                </span>
                <a href={`mailto:${s.email}`}>{s.email}</a>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>Email the families</h2>
          <p className="muted">
            {canAnnounce ? "Send an announcement below; it's saved here and replies come to you. Or use your own email app." : "Open your email app with every parent and guardian on the team in BCC."}
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {canAnnounce && (
              <a className="btn small" href="#announce">
                Send an announcement
              </a>
            )}
            <a
              className={canAnnounce ? "btn ghost small" : "btn small"}
              href={`mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${encodeURIComponent(v.team.name)}`}
            >
              Use my email app
            </a>
          </div>
        </section>
      </div>

      {flags && (
        <TeamTools
          teamId={v.team.id}
          teamName={v.team.name}
          canPractice={canPractice}
          canAnnounce={canAnnounce}
          showPractices={on("r3.practices")}
          showGames={on("r4.games")}
        />
      )}

      <section className="card" style={{ marginTop: 24 }}>
        <h2>Roster</h2>
        {v.canSeeMedical && (
          <p className="muted">
            Medical and emergency details are confidential. Use them only for
            the player's care.
          </p>
        )}
        <table className="simple stack">
          <thead>
            <tr>
              <th>Player</th>
              <th>Parents / guardians</th>
              {v.canSeeMedical && <th>Emergency & medical</th>}
            </tr>
          </thead>
          <tbody>
            {v.roster.map((r) => (
              <tr key={r.entryId}>
                <td data-label="Player">
                  <div className="player-cell">
                    {r.photoUrl ? (
                      <a href={r.photoUrl} target="_blank" rel="noreferrer" className="player-photo">
                        <img src={r.photoUrl} alt={`${r.firstName} ${r.lastName}`} loading="lazy" />
                      </a>
                    ) : (
                      <span className="player-photo empty" aria-hidden="true">
                        {r.firstName[0]}
                        {r.lastName[0]}
                      </span>
                    )}
                    <span>
                      <strong>
                        {r.firstName} {r.lastName}
                      </strong>
                      {r.preferredName ? ` “${r.preferredName}”` : ""}
                      <br />
                      <span className="muted">
                        Born {fmtDate(r.birthDate)}
                        {r.shirtSize ? ` · Shirt ${r.shirtSize}` : ""}
                      </span>
                    </span>
                  </div>
                </td>
                <td data-label="Parents">
                  <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {r.guardians.map((g) => (
                      <div key={g.email}>
                        {g.name} · <a href={`mailto:${g.email}`}>{g.email}</a>
                      </div>
                    ))}
                    {r.householdPhone && (
                      <div>
                        <a
                          href={`tel:${r.householdPhone}`}
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {r.householdPhone}
                        </a>
                      </div>
                    )}
                  </div>
                </td>
                {v.canSeeMedical && (
                  <td data-label="Emergency & medical">
                    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {r.medical ? (
                        <>
                          <div>
                            <strong>Emergency:</strong>{" "}
                            {r.medical.emergencyContactName}
                            {r.medical.emergencyContactRelationship
                              ? ` (${r.medical.emergencyContactRelationship})`
                              : ""}{" "}
                            ·{" "}
                            <a
                              href={`tel:${r.medical.emergencyContactPhone}`}
                              style={{ whiteSpace: "nowrap" }}
                            >
                              {r.medical.emergencyContactPhone}
                            </a>
                          </div>
                          {flagged(r.medical) && (
                            <div style={{ marginTop: 4 }}>
                              <span className="status warn">Medical notes</span>
                              {r.medical.allergies && (
                                <div>Allergies: {r.medical.allergies}</div>
                              )}
                              {r.medical.medicalConditions && (
                                <div>
                                  Conditions: {r.medical.medicalConditions}
                                </div>
                              )}
                              {r.medical.medications && (
                                <div>Medications: {r.medical.medications}</div>
                              )}
                              {r.medical.medicalInstructions && (
                                <div>
                                  Instructions: {r.medical.medicalInstructions}
                                </div>
                              )}
                            </div>
                          )}
                          {r.medical.physicianName && (
                            <div className="muted">
                              Doctor: {r.medical.physicianName}
                              {r.medical.physicianPhone
                                ? ` · ${r.medical.physicianPhone}`
                                : ""}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="muted">Not on file</span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
