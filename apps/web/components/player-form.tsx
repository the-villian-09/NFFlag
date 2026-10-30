"use client";

import { ErrorAlert } from "@/components/form";

export interface PlayerValues {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  birthDate: string;
  gender: "boy" | "girl" | "";
  shirtSize?: string | null;
  school?: string | null;
  grade?: string | null;
  medical: {
    allergies?: string | null;
    medicalConditions?: string | null;
    medications?: string | null;
    medicalInstructions?: string | null;
    physicianName?: string | null;
    physicianPhone?: string | null;
    emergencyContactName: string;
    emergencyContactPhone: string;
    emergencyContactRelationship?: string | null;
  };
}

export const EMPTY_PLAYER: PlayerValues = {
  firstName: "",
  lastName: "",
  birthDate: "",
  gender: "",
  medical: { emergencyContactName: "", emergencyContactPhone: "" },
};

const SHIRT_SIZES = ["YXS", "YS", "YM", "YL", "YXL", "AS", "AM", "AL", "AXL"];

/** Reads the form into the API's player shape. */
export function readPlayerForm(form: HTMLFormElement) {
  const f = new FormData(form);
  const s = (k: string) => String(f.get(k) ?? "").trim();
  return {
    firstName: s("firstName"),
    lastName: s("lastName"),
    preferredName: s("preferredName"),
    birthDate: s("birthDate"),
    gender: s("gender"),
    shirtSize: s("shirtSize"),
    school: s("school"),
    grade: s("grade"),
    medical: {
      allergies: s("allergies"),
      medicalConditions: s("medicalConditions"),
      medications: s("medications"),
      medicalInstructions: s("medicalInstructions"),
      physicianName: s("physicianName"),
      physicianPhone: s("physicianPhone"),
      emergencyContactName: s("emergencyContactName"),
      emergencyContactPhone: s("emergencyContactPhone"),
      emergencyContactRelationship: s("emergencyContactRelationship"),
    },
  };
}

export function PlayerForm({
  initial,
  onSubmit,
  busy,
  error,
  submitLabel,
  lockIdentity,
}: {
  initial: PlayerValues;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  /** Birth date and gender can't change after a paid registration. */
  lockIdentity?: boolean;
}) {
  const m = initial.medical;
  return (
    <form className="stack" onSubmit={onSubmit}>
      <ErrorAlert error={error} />
      <fieldset>
        <legend>Player</legend>
        <div className="form-row">
          <label>
            First name
            <input type="text" name="firstName" required maxLength={60} defaultValue={initial.firstName} autoComplete="off" />
          </label>
          <label>
            Last name
            <input type="text" name="lastName" required maxLength={60} defaultValue={initial.lastName} autoComplete="off" />
          </label>
          <label>
            Goes by (optional)
            <input type="text" name="preferredName" maxLength={60} defaultValue={initial.preferredName ?? ""} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Date of birth
            <input type="date" name="birthDate" required defaultValue={initial.birthDate} readOnly={lockIdentity} max={new Date().toISOString().slice(0, 10)} />
          </label>
          <label>
            Plays in
            <select name="gender" required defaultValue={initial.gender} disabled={lockIdentity}>
              <option value="" disabled>
                Choose…
              </option>
              <option value="boy">Boys divisions</option>
              <option value="girl">Girls divisions</option>
            </select>
            {lockIdentity && <input type="hidden" name="gender" value={initial.gender} />}
          </label>
          <label>
            Shirt size
            <select name="shirtSize" defaultValue={initial.shirtSize ?? ""}>
              <option value="">Choose…</option>
              {SHIRT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        {lockIdentity && <span className="hint">Birth date and division can't be changed after registering. Contact the league if they're wrong.</span>}
        <div className="form-row">
          <label>
            School (optional)
            <input type="text" name="school" maxLength={120} defaultValue={initial.school ?? ""} />
          </label>
          <label>
            Grade (optional)
            <input type="text" name="grade" maxLength={20} defaultValue={initial.grade ?? ""} placeholder="2nd" />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Emergency contact</legend>
        <span className="hint">Someone other than you we can call if we can't reach you.</span>
        <div className="form-row">
          <label>
            Name
            <input type="text" name="emergencyContactName" required maxLength={120} defaultValue={m.emergencyContactName} />
          </label>
          <label>
            Phone
            <input type="tel" name="emergencyContactPhone" required minLength={7} maxLength={32} defaultValue={m.emergencyContactPhone} />
          </label>
          <label>
            Relationship (optional)
            <input type="text" name="emergencyContactRelationship" maxLength={60} defaultValue={m.emergencyContactRelationship ?? ""} placeholder="Grandparent" />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Medical (private)</legend>
        <span className="hint">Only league administrators with medical access see this. Leave blank if none.</span>
        <div className="form-row">
          <label>
            Allergies
            <textarea name="allergies" rows={2} maxLength={1000} defaultValue={m.allergies ?? ""} />
          </label>
          <label>
            Medical conditions
            <textarea name="medicalConditions" rows={2} maxLength={1000} defaultValue={m.medicalConditions ?? ""} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Medications
            <textarea name="medications" rows={2} maxLength={1000} defaultValue={m.medications ?? ""} />
          </label>
          <label>
            Instructions for coaches
            <textarea name="medicalInstructions" rows={2} maxLength={2000} defaultValue={m.medicalInstructions ?? ""} placeholder="e.g. inhaler in bag" />
          </label>
        </div>
        <div className="form-row">
          <label>
            Doctor's name
            <input type="text" name="physicianName" maxLength={120} defaultValue={m.physicianName ?? ""} />
          </label>
          <label>
            Doctor's phone
            <input type="tel" name="physicianPhone" maxLength={32} defaultValue={m.physicianPhone ?? ""} />
          </label>
        </div>
      </fieldset>

      <button className="btn" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
