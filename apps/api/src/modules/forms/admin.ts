/**
 * Admin side of Waivers & forms: the library with completion counts, adding
 * and editing (wording changes make a new version), who has / hasn't
 * completed a form, reminder emails and a spreadsheet export.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import {
  divisions,
  formResponses,
  forms,
  formVersions,
  householdMembers,
  players,
  refereeApplications,
  registrations,
  rosterEntries,
  seasons,
  teams,
  user,
  volunteerApplications,
  type FormQuestion,
} from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { writeAudit } from "../platform/audit.js";
import { publish } from "../platform/outbox.js";
import { SIGNED_UP_REFEREE, SIGNED_UP_REGISTRATION, SIGNED_UP_STAFF, SUBJECT_OF, type Audience, type SubjectType } from "./service.js";

export interface AdminActor {
  userId: string;
  requestId?: string | null;
  ip?: string | null;
}

/* ---------------- input ---------------- */

const question = z.object({
  id: z.string().regex(/^[a-z0-9]{6,24}$/).optional(),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["short", "long", "yesno", "choice", "date", "phone"]),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  help: z.string().trim().max(300).optional(),
});

export const formInput = z
  .object({
    title: z.string().trim().min(2).max(120),
    audience: z.enum(["player", "staff", "referee"]),
    divisionIds: z.array(z.uuid()).max(50).default([]),
    required: z.boolean().default(true),
    askExisting: z.boolean().default(false),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish()
      .transform((v) => v || null),
    body: z.string().max(50_000),
    questions: z.array(question).max(30).default([]),
    /** Saving changed wording or questions: everyone who completed it must do it again. */
    resign: z.boolean().default(false),
    status: z.enum(["draft", "live"]).default("draft"),
  })
  .superRefine((v, ctx) => {
    v.questions.forEach((q, i) => {
      if (q.type === "choice" && (q.options ?? []).length < 2) ctx.addIssue({ code: "custom", path: ["questions", i, "options"], message: `“${q.label}” needs at least two choices.` });
    });
    if (v.audience !== "player" && v.divisionIds.length) ctx.addIssue({ code: "custom", path: ["divisionIds"], message: "Divisions only apply to player forms." });
  });
export type FormInput = z.infer<typeof formInput>;

const newId = () => randomUUID().replace(/-/g, "").slice(0, 12);
const cleanQuestions = (qs: FormInput["questions"]): FormQuestion[] =>
  qs.map((q) => ({
    id: q.id ?? newId(),
    label: q.label,
    type: q.type,
    required: q.required,
    ...(q.type === "choice" ? { options: q.options ?? [] } : {}),
    ...(q.help ? { help: q.help } : {}),
  }));

async function currentSeasonId() {
  const [s] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s?.id ?? null;
}

async function checkDivisions(ids: string[]) {
  if (!ids.length) return;
  const found = await db.select({ id: divisions.id }).from(divisions).where(inArray(divisions.id, ids));
  if (found.length !== new Set(ids).size) throw new HttpError(400, "VALIDATION_FAILED", "Choose divisions from the list.");
}

/* ---------------- who a form is for, and who has done it ---------------- */

export interface Subject {
  subjectType: SubjectType;
  subjectId: string;
  name: string;
  /** Division · team, or the role. */
  detail: string;
  divisionId: string | null;
  /** Accounts to remind. */
  userIds: string[];
  contacts: string;
}

/** Everyone a form currently applies to (this season's sign-ups). */
async function subjectsFor(form: { audience: string; divisionIds: string[] }): Promise<Subject[]> {
  const seasonId = await currentSeasonId();
  if (!seasonId) return [];
  if (form.audience === "player") {
    const regs = await db
      .select({
        id: registrations.id,
        householdId: registrations.householdId,
        divisionId: registrations.divisionId,
        division: divisions.name,
        first: players.firstName,
        last: players.lastName,
      })
      .from(registrations)
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(divisions, eq(divisions.id, registrations.divisionId))
      .where(and(eq(registrations.seasonId, seasonId), inArray(registrations.status, [...SIGNED_UP_REGISTRATION])))
      .orderBy(asc(divisions.sortOrder), asc(players.lastName), asc(players.firstName));
    const mine = regs.filter((r) => form.divisionIds.length === 0 || form.divisionIds.includes(r.divisionId));
    if (!mine.length) return [];
    const team = await db
      .select({ registrationId: rosterEntries.registrationId, name: teams.name })
      .from(rosterEntries)
      .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
      .where(inArray(rosterEntries.registrationId, mine.map((r) => r.id)));
    const parents = await db
      .select({ householdId: householdMembers.householdId, userId: user.id, name: user.name, email: user.email })
      .from(householdMembers)
      .innerJoin(user, eq(user.id, householdMembers.userId))
      .where(inArray(householdMembers.householdId, [...new Set(mine.map((r) => r.householdId))]));
    return mine.map((r) => {
      const ps = parents.filter((p) => p.householdId === r.householdId);
      const t = team.find((x) => x.registrationId === r.id)?.name;
      return {
        subjectType: "registration" as const,
        subjectId: r.id,
        name: `${r.first} ${r.last}`,
        detail: t ? `${r.division} · ${t}` : r.division,
        divisionId: r.divisionId,
        userIds: ps.map((p) => p.userId),
        contacts: ps.map((p) => `${p.name} <${p.email}>`).join("; "),
      };
    });
  }
  const apps =
    form.audience === "staff"
      ? await db
          .select({ id: volunteerApplications.id, userId: volunteerApplications.userId, role: volunteerApplications.roleKey, name: user.name, email: user.email })
          .from(volunteerApplications)
          .innerJoin(user, eq(user.id, volunteerApplications.userId))
          .where(and(eq(volunteerApplications.seasonId, seasonId), inArray(volunteerApplications.status, [...SIGNED_UP_STAFF])))
          .orderBy(asc(user.name))
      : await db
          .select({ id: refereeApplications.id, userId: refereeApplications.userId, role: refereeApplications.status, name: user.name, email: user.email })
          .from(refereeApplications)
          .innerJoin(user, eq(user.id, refereeApplications.userId))
          .where(and(eq(refereeApplications.seasonId, seasonId), inArray(refereeApplications.status, [...SIGNED_UP_REFEREE])))
          .orderBy(asc(user.name));
  const ROLE: Record<string, string> = { head_coach: "Head coach", assistant_coach: "Assistant coach", team_manager: "Team mom", submitted: "Referee", approved: "Referee" };
  return apps.map((a) => ({
    subjectType: SUBJECT_OF[form.audience as Audience],
    subjectId: a.id,
    name: a.name,
    detail: ROLE[a.role] ?? a.role,
    divisionId: null,
    userIds: [a.userId],
    contacts: `${a.name} <${a.email}>`,
  }));
}

async function minVersionOf(formId: string) {
  const vs = await db.select({ version: formVersions.version, resign: formVersions.resign }).from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version));
  return vs.find((v) => v.resign)?.version ?? 1;
}

/** Each subject with their latest response (if it still counts). */
export async function tracking(formId: string) {
  const [f] = await db.select().from(forms).where(eq(forms.id, formId));
  if (!f) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  const subjects = await subjectsFor(f);
  const min = await minVersionOf(f.id);
  const responses = subjects.length
    ? await db
        .select()
        .from(formResponses)
        .where(and(eq(formResponses.formId, f.id), inArray(formResponses.subjectId, subjects.map((s) => s.subjectId))))
        .orderBy(desc(formResponses.version), desc(formResponses.signedAt))
    : [];
  const rows = subjects.map((s) => {
    const r = responses.find((x) => x.subjectId === s.subjectId && x.subjectType === s.subjectType && x.version >= min);
    return {
      ...s,
      done: !!r,
      response: r ? { agreed: r.agreed, signerName: r.signerName, signedAt: r.signedAt, version: r.version, answers: r.answers } : null,
    };
  });
  return { form: f, minVersion: min, rows };
}

/* ---------------- library ---------------- */

export async function listForms() {
  const all = await db.select().from(forms).where(inArray(forms.status, ["draft", "live", "archived"])).orderBy(asc(forms.audience), asc(forms.sortOrder), asc(forms.createdAt));
  const versions = all.length ? await db.select().from(formVersions).where(inArray(formVersions.formId, all.map((f) => f.id))).orderBy(desc(formVersions.version)) : [];
  const divs = await db.select({ id: divisions.id, name: divisions.name }).from(divisions);
  return Promise.all(
    all.map(async (f) => {
      const cur = versions.find((v) => v.formId === f.id);
      const t = f.status === "archived" ? null : await tracking(f.id);
      return {
        id: f.id,
        title: cur?.title ?? f.title,
        audience: f.audience,
        divisions: f.divisionIds.map((id) => divs.find((d) => d.id === id)?.name ?? "—"),
        required: f.required,
        status: f.status,
        askExisting: f.askExisting,
        dueDate: f.dueDate,
        version: cur?.version ?? 1,
        questions: cur?.questions.length ?? 0,
        done: t ? t.rows.filter((r) => r.done).length : 0,
        total: t ? t.rows.length : 0,
        updatedAt: f.updatedAt,
      };
    }),
  );
}

export async function getForm(id: string) {
  const [f] = await db.select().from(forms).where(eq(forms.id, id));
  if (!f) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  const versions = await db.select().from(formVersions).where(eq(formVersions.formId, id)).orderBy(desc(formVersions.version));
  const cur = versions[0]!;
  const [{ n } = { n: 0 }] = await db.$count(formResponses, eq(formResponses.formId, id)).then((n) => [{ n }]);
  return {
    form: { ...f, title: cur.title, body: cur.body, questions: cur.questions, version: cur.version },
    versions: versions.map((v) => ({ version: v.version, title: v.title, resign: v.resign, createdAt: v.createdAt })),
    responses: n,
  };
}

/** Sends reminder emails (one per account, through the outbox) to everyone who hasn't completed it. */
async function queueReminders(formId: string, opts: { force?: boolean } = {}) {
  const t = await tracking(formId);
  const f = t.form;
  if (f.status !== "live") throw new HttpError(409, "CONFLICT", "Publish the form before sending reminders.");
  if (!f.askExisting) throw new HttpError(409, "CONFLICT", "Turn on “Also ask people who already signed up” first; that's where reminders send people.");
  if (!opts.force && f.remindedAt && Date.now() - f.remindedAt.getTime() < 20 * 3600_000) {
    throw new HttpError(409, "CONFLICT", "Reminders for this form already went out in the last day.");
  }
  const missing = t.rows.filter((r) => !r.done);
  const byUser = new Map<string, string[]>();
  for (const r of missing) for (const u of r.userIds) byUser.set(u, [...(byUser.get(u) ?? []), r.name]);
  const batch = randomUUID();
  for (const [userId, names] of byUser) {
    await publish(db, {
      name: "form.reminder",
      aggregateType: "form",
      aggregateId: formId,
      payload: { userId, names },
      dedupeKey: `form.reminder:${formId}:${userId}:${batch}`,
    });
  }
  await db.update(forms).set({ remindedAt: new Date() }).where(eq(forms.id, formId));
  return { people: missing.length, emails: byUser.size };
}

export async function remind(actor: AdminActor, formId: string) {
  const r = await queueReminders(formId);
  await writeAudit(db, { actorUserId: actor.userId, action: "form.remind", targetType: "form", targetId: formId, after: r, requestId: actor.requestId, ipAddress: actor.ip });
  return r;
}

export async function createForm(actor: AdminActor, input: FormInput) {
  await checkDivisions(input.divisionIds);
  const f = await db.transaction(async (tx) => {
    const [{ next } = { next: 1 }] = await tx
      .select({ next: forms.sortOrder })
      .from(forms)
      .where(eq(forms.audience, input.audience))
      .orderBy(desc(forms.sortOrder))
      .limit(1)
      .then((r) => r.map((x) => ({ next: x.next + 1 })));
    const [row] = await tx
      .insert(forms)
      .values({
        title: input.title,
        audience: input.audience,
        divisionIds: input.divisionIds,
        required: input.required,
        askExisting: input.askExisting,
        dueDate: input.dueDate,
        status: input.status,
        sortOrder: next,
        createdBy: actor.userId,
      })
      .returning();
    await tx.insert(formVersions).values({ formId: row!.id, version: 1, title: input.title, body: input.body, questions: cleanQuestions(input.questions), createdBy: actor.userId });
    await writeAudit(tx, { actorUserId: actor.userId, action: "form.create", targetType: "form", targetId: row!.id, after: { ...input }, requestId: actor.requestId, ipAddress: actor.ip });
    return row!;
  });
  const reminded = f.status === "live" && f.askExisting ? await queueReminders(f.id, { force: true }).catch(() => null) : null;
  return { id: f.id, reminded };
}

/** Compares questions regardless of key order (the database reorders JSON keys). */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v;
const sameQuestions = (a: FormQuestion[], b: FormQuestion[]) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function updateForm(actor: AdminActor, id: string, input: FormInput) {
  await checkDivisions(input.divisionIds);
  const result = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(forms).where(eq(forms.id, id)).for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Form not found.");
    if (before.audience !== input.audience) throw new HttpError(409, "CONFLICT", "Who completes a form can't change once it's made. Add a new form instead.");
    const [cur] = await tx.select().from(formVersions).where(eq(formVersions.formId, id)).orderBy(desc(formVersions.version)).limit(1);
    const qs = cleanQuestions(input.questions);
    // Wording, title or questions changed: a new version (what people already signed stays as it was).
    const changed = !cur || cur.title !== input.title || cur.body !== input.body || !sameQuestions(cur.questions, qs);
    let version = cur?.version ?? 1;
    if (changed) {
      version += 1;
      await tx.insert(formVersions).values({ formId: id, version, title: input.title, body: input.body, questions: qs, resign: input.resign, createdBy: actor.userId });
    }
    const [after] = await tx
      .update(forms)
      .set({
        title: input.title,
        divisionIds: input.divisionIds,
        required: input.required,
        askExisting: input.askExisting,
        dueDate: input.dueDate,
        status: before.status === "archived" ? "archived" : input.status,
        updatedAt: new Date(),
      })
      .where(eq(forms.id, id))
      .returning();
    await writeAudit(tx, {
      actorUserId: actor.userId,
      action: "form.update",
      targetType: "form",
      targetId: id,
      before: { status: before.status, required: before.required, askExisting: before.askExisting, divisionIds: before.divisionIds, version: cur?.version },
      after: { status: after!.status, required: after!.required, askExisting: after!.askExisting, divisionIds: after!.divisionIds, version, resign: changed && input.resign },
      requestId: actor.requestId,
      ipAddress: actor.ip,
    });
    const notify = after!.status === "live" && after!.askExisting && (before.status !== "live" || !before.askExisting || (changed && input.resign));
    return { version, newVersion: changed, notify };
  });
  const reminded = result.notify ? await queueReminders(id, { force: true }).catch(() => null) : null;
  return { version: result.version, newVersion: result.newVersion, reminded };
}

/** Archive (stop asking; keep every signature) or bring back. */
export async function setArchived(actor: AdminActor, id: string, archived: boolean) {
  const [before] = await db.select().from(forms).where(eq(forms.id, id));
  if (!before) throw new HttpError(404, "NOT_FOUND", "Form not found.");
  const status = archived ? "archived" : "draft";
  await db.update(forms).set({ status, updatedAt: new Date() }).where(eq(forms.id, id));
  await writeAudit(db, { actorUserId: actor.userId, action: archived ? "form.archive" : "form.unarchive", targetType: "form", targetId: id, before: { status: before.status }, after: { status }, requestId: actor.requestId, ipAddress: actor.ip });
}

/** Spreadsheet-safe CSV cell: quotes, and neutralizes formulas (=, +, -, @). */
function csvCell(v: unknown) {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One row per person: status, signer, date, version and every answer. */
export async function exportCsv(actor: AdminActor, id: string) {
  const t = await tracking(id);
  const [cur] = await db.select().from(formVersions).where(eq(formVersions.formId, id)).orderBy(desc(formVersions.version)).limit(1);
  const qs = cur?.questions ?? [];
  const header = ["Name", "Division / role", "Contacts", "Status", "Agreed", "Signed by", "Signed at", "Version", ...qs.map((q) => q.label)];
  const lines = t.rows.map((r) =>
    [
      r.name,
      r.detail,
      r.contacts,
      r.done ? "Done" : "Not done",
      r.response ? (r.response.agreed ? "Yes" : "No") : "",
      r.response?.signerName ?? "",
      r.response?.signedAt ?? "",
      r.response?.version ?? "",
      ...qs.map((q) => r.response?.answers[q.id] ?? ""),
    ]
      .map(csvCell)
      .join(","),
  );
  await writeAudit(db, { actorUserId: actor.userId, action: "form.export", targetType: "form", targetId: id, after: { rows: t.rows.length }, requestId: actor.requestId, ipAddress: actor.ip });
  const name = (cur?.title ?? "form").replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
  return { filename: `nffl-${name}-${new Date().toISOString().slice(0, 10)}.csv`, csv: [header.map(csvCell).join(","), ...lines].join("\r\n") };
}
