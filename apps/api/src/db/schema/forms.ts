/**
 * Waivers & forms library (Nov 18). Admins add agreements and forms; families,
 * coaches/staff or referees complete them at sign-up or later from My account.
 *
 *   forms           one per waiver/form: who completes it, divisions, required
 *   form_versions   the wording and questions; editing makes a new version
 *   form_responses  who completed which version, for which registration or
 *                   application, with their answers and typed signature
 */
import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const forms = pgTable(
  "forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** player (parents, once per registration) | staff (coaches & team staff) | referee */
    audience: text("audience").notNull(),
    /** Player forms only: division ids it applies to; empty = every division. */
    divisionIds: jsonb("division_ids").$type<string[]>().notNull().default([]),
    /** Required to take part; optional forms record a yes/no. */
    required: boolean("required").notNull().default(true),
    /** draft | live | archived */
    status: text("status").notNull().default("draft"),
    /** Also ask people who already signed up (shown on My account, emailed). */
    askExisting: boolean("ask_existing").notNull().default(false),
    dueDate: date("due_date"),
    /** The content page this form came from (the original waivers), if any. */
    legacySlug: text("legacy_slug"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Last time reminder emails went out (at most once a day). */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("forms_legacy_slug").on(t.legacySlug).where(sql`${t.legacySlug} is not null`)],
);

export interface FormQuestion {
  id: string;
  label: string;
  /** short | long | yesno | choice | date | phone */
  type: "short" | "long" | "yesno" | "choice" | "date" | "phone";
  required: boolean;
  /** For "choice". */
  options?: string[];
  help?: string;
}

export const formVersions = pgTable(
  "form_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    /** Markdown wording. */
    body: text("body").notNull(),
    questions: jsonb("questions").$type<FormQuestion[]>().notNull().default([]),
    /** Everyone who completed an earlier version must complete this one. */
    resign: boolean("resign").notNull().default(false),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("form_versions_form_version").on(t.formId, t.version)],
);

export const formResponses = pgTable(
  "form_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => formVersions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** registration | staff_application | referee_application */
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** Who completed it (the parent's or applicant's account). */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    signerName: text("signer_name").notNull(),
    /** false: an optional form the person declined. */
    agreed: boolean("agreed").notNull(),
    /** { questionId: answer } */
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    /** SHA-256 of the wording they saw. */
    sha256: text("sha256").notNull(),
    ipAddress: text("ip_address"),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("form_responses_once").on(t.formId, t.subjectType, t.subjectId, t.version),
    index("form_responses_subject").on(t.subjectType, t.subjectId),
  ],
);
