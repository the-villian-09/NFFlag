/**
 * Waivers & forms (Nov 18): which forms apply to whom, checking and recording
 * what people complete, and who still needs to.
 *
 * Audiences and what a response is tied to ("subject"):
 *   player   parents, once per registration      subject: registration
 *   staff    coaches & team staff                subject: staff (volunteer) application
 *   referee  referees                            subject: referee application
 *
 * A response counts for a form when its version is at or after the latest
 * version marked "everyone signs again" (or any version if none is).
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { COACHES_HONOR, coachesHonorMarkdown } from "@nffl/shared";
import { db, type DbOrTx } from "../../db/client.js";
import {
  contentPages,
  divisions,
  formResponses,
  forms,
  formVersions,
  householdMembers,
  players,
  refereeApplications,
  registrations,
  seasons,
  user,
  volunteerApplications,
  type FormQuestion,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { DEFAULT_PAGES } from "../content/defaults.js";

export type Audience = "player" | "staff" | "referee";
export type SubjectType = "registration" | "staff_application" | "referee_application";
export const SUBJECT_OF: Record<Audience, SubjectType> = { player: "registration", staff: "staff_application", referee: "referee_application" };

/** Registrations that count as signed up (not abandoned, cancelled or rejected). */
export const SIGNED_UP_REGISTRATION = ["processing", "paid", "approved"] as const;
export const SIGNED_UP_STAFF = ["submitted", "approved"] as const;
export const SIGNED_UP_REFEREE = ["submitted", "approved"] as const;

export interface LiveForm {
  id: string;
  title: string;
  audience: Audience;
  required: boolean;
  divisionIds: string[];
  askExisting: boolean;
  dueDate: string | null;
  versionId: string;
  version: number;
  /** Oldest version a response may be for and still count. */
  minVersion: number;
  body: string;
  questions: FormQuestion[];
  /** The original waiver page this form came from, if any. */
  legacySlug: string | null;
}

export interface ResponseInput {
  formId: string;
  agreed: boolean;
  answers?: Record<string, string>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Live forms (current wording) for an audience, optionally only those that apply to a division. */
export async function liveForms(audience: Audience, opts: { divisionId?: string; onlyAskExisting?: boolean } = {}, conn: DbOrTx = db): Promise<LiveForm[]> {
  const rows = await conn
    .select()
    .from(forms)
    .where(and(eq(forms.audience, audience), eq(forms.status, "live")))
    .orderBy(asc(forms.sortOrder), asc(forms.createdAt));
  const wanted = rows.filter(
    (f) => (!opts.divisionId || f.divisionIds.length === 0 || f.divisionIds.includes(opts.divisionId)) && (!opts.onlyAskExisting || f.askExisting),
  );
  if (!wanted.length) return [];
  const versions = await conn
    .select()
    .from(formVersions)
    .where(inArray(formVersions.formId, wanted.map((f) => f.id)))
    .orderBy(desc(formVersions.version));
  return wanted.flatMap((f) => {
    const vs = versions.filter((v) => v.formId === f.id);
    const cur = vs[0];
    if (!cur) return [];
    const minVersion = vs.find((v) => v.resign)?.version ?? 1;
    return [
      {
        id: f.id,
        title: cur.title,
        audience: f.audience as Audience,
        required: f.required,
        divisionIds: f.divisionIds,
        askExisting: f.askExisting,
        dueDate: f.dueDate,
        versionId: cur.id,
        version: cur.version,
        minVersion,
        body: cur.body,
        questions: cur.questions,
        legacySlug: f.legacySlug,
      },
    ];
  });
}

/** Pages built before forms existed send the original waiver slugs they ticked. */
export function fromLegacy(applicable: LiveForm[], slugs: string[], inputs: ResponseInput[]): ResponseInput[] {
  const given = new Set(inputs.map((i) => i.formId));
  const legacy = applicable.filter((f) => f.legacySlug && slugs.includes(f.legacySlug) && !given.has(f.id)).map((f) => ({ formId: f.id, agreed: true }));
  return [...inputs, ...legacy];
}

/** What the sign-up screens show: wording, questions, required. */
export const publicForm = (f: LiveForm) => ({
  id: f.id,
  title: f.title,
  required: f.required,
  version: f.version,
  body: f.body,
  questions: f.questions,
  dueDate: f.dueDate,
});

const PHONE = /^[\d\s()+.-]{7,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks one person's answers to one form; returns the cleaned answers. */
function cleanAnswers(f: LiveForm, input: ResponseInput): Record<string, string> {
  if (!input.agreed) return {};
  const given = input.answers ?? {};
  const out: Record<string, string> = {};
  for (const q of f.questions) {
    const v = (given[q.id] ?? "").trim();
    if (!v) {
      if (q.required) throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: please answer “${q.label}”.`);
      continue;
    }
    if (v.length > (q.type === "long" ? 2000 : 300)) throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: “${q.label}” is too long.`);
    if (q.type === "yesno" && v !== "yes" && v !== "no") throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: answer yes or no to “${q.label}”.`);
    if (q.type === "choice" && !(q.options ?? []).includes(v)) throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: choose an answer for “${q.label}”.`);
    if (q.type === "date" && !DATE.test(v)) throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: enter a date for “${q.label}”.`);
    if (q.type === "phone" && !PHONE.test(v)) throw new HttpError(400, "VALIDATION_FAILED", `${f.title}: enter a phone number for “${q.label}”.`);
    out[q.id] = v;
  }
  return out;
}

/**
 * Checks a sign-up's responses against the forms that apply: every required
 * form agreed to, required questions answered. Optional forms may be agreed
 * or declined (or skipped). Returns what to record.
 */
export function checkResponses(applicable: LiveForm[], inputs: ResponseInput[]) {
  const byId = new Map(inputs.map((i) => [i.formId, i]));
  const missing = applicable.filter((f) => f.required && !byId.get(f.id)?.agreed);
  if (missing.length) throw new HttpError(400, "VALIDATION_FAILED", `Please accept: ${missing.map((f) => f.title).join(", ")}.`);
  return applicable.flatMap((f) => {
    const i = byId.get(f.id);
    return i ? [{ form: f, agreed: i.agreed, answers: cleanAnswers(f, i) }] : [];
  });
}

/** Saves responses for one subject (a registration or application). Already-recorded versions are kept. */
export async function recordResponses(
  tx: DbOrTx,
  who: { subjectType: SubjectType; subjectId: string; userId: string | null; signerName: string; ip?: string | null },
  checked: ReturnType<typeof checkResponses>,
) {
  if (!checked.length) return;
  await tx
    .insert(formResponses)
    .values(
      checked.map((c) => ({
        formId: c.form.id,
        versionId: c.form.versionId,
        version: c.form.version,
        subjectType: who.subjectType,
        subjectId: who.subjectId,
        userId: who.userId,
        signerName: who.signerName,
        agreed: c.agreed,
        answers: c.answers,
        sha256: sha(c.form.body),
        ipAddress: who.ip ?? null,
      })),
    )
    .onConflictDoNothing();
}

/** The snapshot kept on registrations / applications (same shape as before forms existed). */
export const snapshot = (checked: ReturnType<typeof checkResponses>, signerName: string, at = new Date()) =>
  checked
    .filter((c) => c.agreed)
    .map((c) => ({ slug: c.form.id, title: c.form.title, version: String(c.form.version), sha256: sha(c.form.body), signerName, acceptedAt: at }));

/** Which (form, subject) pairs already have a response that counts. */
async function doneSet(subjectType: SubjectType, subjectIds: string[], fs: LiveForm[], conn: DbOrTx = db) {
  if (!subjectIds.length || !fs.length) return new Set<string>();
  const rows = await conn
    .select({ formId: formResponses.formId, subjectId: formResponses.subjectId, version: formResponses.version })
    .from(formResponses)
    .where(and(eq(formResponses.subjectType, subjectType), inArray(formResponses.subjectId, subjectIds), inArray(formResponses.formId, fs.map((f) => f.id))));
  const min = new Map(fs.map((f) => [f.id, f.minVersion]));
  return new Set(rows.filter((r) => r.version >= (min.get(r.formId) ?? 1)).map((r) => `${r.formId}:${r.subjectId}`));
}

async function currentSeasonId(conn: DbOrTx = db) {
  const [s] = await conn.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s?.id ?? null;
}

export interface OutstandingItem {
  form: ReturnType<typeof publicForm>;
  subjectType: SubjectType;
  subjectId: string;
  /** "Jordan · 10U Boys", "Coach application", "Referee". */
  label: string;
}

/** Forms a signed-in person still needs to complete for things they already signed up for. */
export async function outstandingFor(userId: string): Promise<OutstandingItem[]> {
  const seasonId = await currentSeasonId();
  if (!seasonId) return [];
  const out: OutstandingItem[] = [];

  // Their children's registrations.
  const playerForms = await liveForms("player", { onlyAskExisting: true });
  if (playerForms.length) {
    const regs = await db
      .select({ id: registrations.id, divisionId: registrations.divisionId, division: divisions.name, first: players.firstName })
      .from(registrations)
      .innerJoin(householdMembers, eq(householdMembers.householdId, registrations.householdId))
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
      .where(and(eq(householdMembers.userId, userId), eq(registrations.seasonId, seasonId), inArray(registrations.status, [...SIGNED_UP_REGISTRATION])));
    const done = await doneSet("registration", regs.map((r) => r.id), playerForms);
    for (const r of regs)
      for (const f of playerForms)
        if ((f.divisionIds.length === 0 || f.divisionIds.includes(r.divisionId)) && !done.has(`${f.id}:${r.id}`))
          out.push({ form: publicForm(f), subjectType: "registration", subjectId: r.id, label: `${r.first} · ${r.division}` });
  }

  // Their coach / team staff application.
  const staffForms = await liveForms("staff", { onlyAskExisting: true });
  if (staffForms.length) {
    const apps = await db
      .select({ id: volunteerApplications.id })
      .from(volunteerApplications)
      .where(and(eq(volunteerApplications.userId, userId), eq(volunteerApplications.seasonId, seasonId), inArray(volunteerApplications.status, [...SIGNED_UP_STAFF])));
    const done = await doneSet("staff_application", apps.map((a) => a.id), staffForms);
    for (const a of apps)
      for (const f of staffForms)
        if (!done.has(`${f.id}:${a.id}`)) out.push({ form: publicForm(f), subjectType: "staff_application", subjectId: a.id, label: "Coaches & team staff" });
  }

  // Their referee sign-up.
  const refForms = await liveForms("referee", { onlyAskExisting: true });
  if (refForms.length) {
    const apps = await db
      .select({ id: refereeApplications.id })
      .from(refereeApplications)
      .where(and(eq(refereeApplications.userId, userId), eq(refereeApplications.seasonId, seasonId), inArray(refereeApplications.status, [...SIGNED_UP_REFEREE])));
    const done = await doneSet("referee_application", apps.map((a) => a.id), refForms);
    for (const a of apps)
      for (const f of refForms) if (!done.has(`${f.id}:${a.id}`)) out.push({ form: publicForm(f), subjectType: "referee_application", subjectId: a.id, label: "Referee" });
  }
  return out;
}

/** Is this registration / application this person's? */
async function ownsSubject(userId: string, subjectType: SubjectType, subjectId: string) {
  if (subjectType === "registration") {
    const [r] = await db
      .select({ id: registrations.id, divisionId: registrations.divisionId })
      .from(registrations)
      .innerJoin(householdMembers, eq(householdMembers.householdId, registrations.householdId))
      .where(and(eq(registrations.id, subjectId), eq(householdMembers.userId, userId), inArray(registrations.status, [...SIGNED_UP_REGISTRATION])));
    return r ? { divisionId: r.divisionId } : null;
  }
  if (subjectType === "staff_application") {
    const [a] = await db
      .select({ id: volunteerApplications.id })
      .from(volunteerApplications)
      .where(and(eq(volunteerApplications.id, subjectId), eq(volunteerApplications.userId, userId), inArray(volunteerApplications.status, [...SIGNED_UP_STAFF])));
    return a ? {} : null;
  }
  const [a] = await db
    .select({ id: refereeApplications.id })
    .from(refereeApplications)
    .where(and(eq(refereeApplications.id, subjectId), eq(refereeApplications.userId, userId), inArray(refereeApplications.status, [...SIGNED_UP_REFEREE])));
  return a ? {} : null;
}

const AUDIENCE_OF: Record<SubjectType, Audience> = { registration: "player", staff_application: "staff", referee_application: "referee" };

/** Completing one form after sign-up (from My account). */
export async function completeForm(
  who: { userId: string; ip?: string | null },
  input: { formId: string; subjectType: SubjectType; subjectId: string; signerName: string; agreed: boolean; answers?: Record<string, string> },
) {
  const owns = await ownsSubject(who.userId, input.subjectType, input.subjectId);
  if (!owns) throw new HttpError(404, "NOT_FOUND", "Not found.");
  const fs = await liveForms(AUDIENCE_OF[input.subjectType], { divisionId: "divisionId" in owns ? owns.divisionId : undefined });
  const f = fs.find((x) => x.id === input.formId);
  if (!f) throw new HttpError(404, "NOT_FOUND", "This form isn't available.");
  if (f.required && !input.agreed) throw new HttpError(400, "VALIDATION_FAILED", `Please accept the ${f.title.toLowerCase()}.`);
  const checked = checkResponses([f], [{ formId: f.id, agreed: input.agreed, answers: input.answers }]);
  await recordResponses(db, { subjectType: input.subjectType, subjectId: input.subjectId, userId: who.userId, signerName: input.signerName, ip: who.ip }, checked);
  return { form: publicForm(f) };
}

/** Everything a person has completed (My account → signed waivers & forms). */
export async function completedBy(userId: string) {
  const rows = await db
    .select({
      id: formResponses.id,
      title: formVersions.title,
      body: formVersions.body,
      version: formResponses.version,
      agreed: formResponses.agreed,
      signerName: formResponses.signerName,
      signedAt: formResponses.signedAt,
      answers: formResponses.answers,
      questions: formVersions.questions,
      subjectType: formResponses.subjectType,
      subjectId: formResponses.subjectId,
    })
    .from(formResponses)
    .innerJoin(formVersions, eq(formVersions.id, formResponses.versionId))
    .where(eq(formResponses.userId, userId))
    .orderBy(desc(formResponses.signedAt))
    .limit(200);
  return rows;
}

/* ---------------- the original waivers become forms ---------------- */

/** Content pages that were the waivers and the coach agreement, and the forms they become. */
const LEGACY: { slug: string; audience: Audience; required: boolean; sortOrder: number }[] = [
  { slug: "waiver-liability", audience: "player", required: true, sortOrder: 1 },
  { slug: "waiver-medical", audience: "player", required: true, sortOrder: 2 },
  { slug: "waiver-media", audience: "player", required: true, sortOrder: 3 },
  { slug: "volunteer-agreement", audience: "staff", required: true, sortOrder: 1 },
];

/**
 * Run on every deploy (seed): creates a live form from each original waiver
 * page the first time, with the page's current wording as version 1, and
 * copies the acceptances already stored on registrations and staff
 * applications into form_responses. Safe to run again.
 */
export async function seedLegacyForms(conn: DbOrTx = db) {
  for (const l of LEGACY) {
    const [existing] = await conn.select({ id: forms.id }).from(forms).where(eq(forms.legacySlug, l.slug));
    if (existing) continue;
    const [page] = await conn.select().from(contentPages).where(eq(contentPages.slug, l.slug));
    const fallback = DEFAULT_PAGES.find((p) => p.slug === l.slug);
    const title = page?.title ?? fallback?.title;
    const body = page?.body ?? fallback?.body;
    if (!title || body === undefined) continue;
    const [f] = await conn
      .insert(forms)
      .values({ title, audience: l.audience, required: l.required, status: "live", legacySlug: l.slug, sortOrder: l.sortOrder })
      .onConflictDoNothing()
      .returning();
    if (!f) continue;
    await conn.insert(formVersions).values({ formId: f.id, version: 1, title, body });
  }
  await copyLegacyAcceptances(conn);
}

/**
 * The Coaches Honor: a required coach & staff form, created once. After that
 * it's the league's to edit, make optional or archive in Waivers & forms.
 * It isn't put to coaches already approved unless an admin turns on
 * "Also ask people who already signed up".
 */
export async function seedCoachesHonor(conn: DbOrTx = db) {
  const [existing] = await conn.select({ id: forms.id }).from(forms).where(eq(forms.legacySlug, COACHES_HONOR_SLUG));
  if (existing) return;
  const title = COACHES_HONOR.formTitle;
  const body = coachesHonorMarkdown();
  const [f] = await conn
    .insert(forms)
    .values({ title, audience: "staff", required: true, status: "live", legacySlug: COACHES_HONOR_SLUG, sortOrder: 2 })
    .onConflictDoNothing()
    .returning();
  if (f) await conn.insert(formVersions).values({ formId: f.id, version: 1, title, body });
}
export const COACHES_HONOR_SLUG = "coaches-honor";

/** Acceptances stored on registrations / staff applications before forms existed → form_responses. */
async function copyLegacyAcceptances(conn: DbOrTx) {
  const legacy = await conn
    .select({ formId: forms.id, slug: forms.legacySlug, versionId: formVersions.id })
    .from(forms)
    .innerJoin(formVersions, and(eq(formVersions.formId, forms.id), eq(formVersions.version, 1)))
    .where(sql`${forms.legacySlug} is not null`);
  const bySlug = new Map(legacy.map((l) => [l.slug!, l]));
  type Accepted = { slug: string; sha256?: string; signerName?: string; acceptedAt?: string };
  const copy = async (subjectType: SubjectType, rows: { id: string; userId: string | null; items: unknown }[]) => {
    const values = rows.flatMap((r) =>
      ((Array.isArray(r.items) ? r.items : []) as Accepted[]).flatMap((a) => {
        const l = bySlug.get(a.slug);
        if (!l || !a.signerName) return [];
        return [
          {
            formId: l.formId,
            versionId: l.versionId,
            version: 1,
            subjectType,
            subjectId: r.id,
            userId: r.userId,
            signerName: a.signerName,
            agreed: true,
            answers: {},
            sha256: a.sha256 ?? "",
            signedAt: a.acceptedAt ? new Date(a.acceptedAt) : new Date(),
          },
        ];
      }),
    );
    for (let i = 0; i < values.length; i += 500) await conn.insert(formResponses).values(values.slice(i, i + 500)).onConflictDoNothing();
  };
  await copy(
    "registration",
    (
      await conn
        .select({ id: registrations.id, userId: registrations.submittedBy, items: registrations.waivers })
        .from(registrations)
        .where(sql`jsonb_array_length(${registrations.waivers}) > 0`)
    ),
  );
  await copy(
    "staff_application",
    (
      await conn
        .select({ id: volunteerApplications.id, userId: volunteerApplications.userId, items: volunteerApplications.agreements })
        .from(volunteerApplications)
        .where(sql`jsonb_array_length(${volunteerApplications.agreements}) > 0`)
    ),
  );
}

/** The user's display name and email (for reminder emails). */
export async function userContact(ids: string[]) {
  if (!ids.length) return [];
  return db.select({ id: user.id, email: user.email, name: user.name }).from(user).where(inArray(user.id, ids));
}
