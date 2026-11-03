/**
 * Required uploads (release switch r6.documents):
 *   - each child: birth certificate (kept for later seasons), insurance card
 *     and headshot (each season), before the registration can be paid;
 *   - coaches, team moms and referees: a headshot each season, before paying
 *     the staff fee / signing up to referee.
 *
 * Photos are decoded and re-encoded as JPEG, which drops hidden data such as
 * the GPS location phones add. PDFs (birth certificates, insurance cards) are
 * kept as uploaded. Who may see a file is decided here, per request.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { MAX_INPUT_PIXELS, oneAtATime } from "../../lib/images.js";
import { db } from "../../db/client.js";
import { documents, householdMembers, players, registrations, rosterEntries, seasons, teams } from "../../db/schema/index.js";
import { HttpError } from "../../http/errors.js";
import { fileStore } from "../../lib/storage.js";
import { logger } from "../../lib/logger.js";
import { can, type Access } from "../platform/access.js";
import { writeAudit } from "../platform/audit.js";
import { isEnabled } from "../platform/flags.js";

export const DOCUMENTS_FLAG = "r6.documents";

export type PlayerKind = "birth_certificate" | "insurance_card" | "player_photo";
export type DocKind = PlayerKind | "staff_photo";
export const PLAYER_KINDS: PlayerKind[] = ["birth_certificate", "insurance_card", "player_photo"];

export const KIND_INFO: Record<DocKind, { label: string; perSeason: boolean; photo: boolean; sensitive: boolean }> = {
  birth_certificate: { label: "Birth certificate", perSeason: false, photo: false, sensitive: true },
  insurance_card: { label: "Medical insurance card", perSeason: true, photo: false, sensitive: true },
  player_photo: { label: "Headshot", perSeason: true, photo: true, sensitive: false },
  staff_photo: { label: "Headshot", perSeason: true, photo: true, sensitive: false },
};

/** Largest upload accepted (the browser shrinks photos well below this). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

type Doc = typeof documents.$inferSelect;

export async function documentsRequired() {
  return isEnabled(DOCUMENTS_FLAG);
}

export async function currentSeasonId() {
  const [s] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
  return s?.id ?? null;
}

/* ---------------- file handling ---------------- */

export function sniff(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Scanned documents don't need scripts, attachments or form actions; a PDF
 * with them is refused. (Best effort: PDFs are also always downloaded rather
 * than opened inside the site; see documents/routes.ts.)
 */
const PDF_ACTIVE = /\/(?:JavaScript|JS|Launch|EmbeddedFiles?|SubmitForm|ImportData|RichMedia|XFA|GoToR|GoToE)\b/;
export function pdfHasActiveContent(buf: Buffer) {
  return PDF_ACTIVE.test(buf.toString("latin1"));
}

/** Checks the file really is what it claims and cleans photos. Returns what to store. */
export async function prepareFile(kind: DocKind, buf: Buffer): Promise<{ data: Buffer; contentType: string }> {
  if (!buf.length) throw new HttpError(400, "VALIDATION_FAILED", "Choose a file to upload.");
  if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(400, "VALIDATION_FAILED", "That file is too large. The limit is 4 MB.");
  const type = sniff(buf);
  if (!type) throw new HttpError(400, "VALIDATION_FAILED", "Upload a photo (JPG, PNG or WebP) or a PDF.");
  if (type === "application/pdf") {
    if (KIND_INFO[kind].photo) throw new HttpError(400, "VALIDATION_FAILED", "The headshot needs to be a photo (JPG, PNG or WebP), not a PDF.");
    if (pdfHasActiveContent(buf)) {
      throw new HttpError(400, "VALIDATION_FAILED", "That PDF contains scripts, attachments or form actions, so it can't be uploaded. Take a photo of the document instead, or scan it to a plain PDF.");
    }
    return { data: buf, contentType: type };
  }
  try {
    const max = KIND_INFO[kind].photo ? 1200 : 2400;
    const data = await oneAtATime(() =>
      sharp(buf, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
        .rotate() // apply the phone's orientation before the metadata is dropped
        .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer(),
    );
    return { data, contentType: "image/jpeg" };
  } catch {
    throw new HttpError(400, "VALIDATION_FAILED", "That photo couldn't be read. Try taking it again or uploading a different file.");
  }
}

function storeOrFail() {
  const s = fileStore();
  if (!s) throw new HttpError(503, "PAYMENTS_UNAVAILABLE", "Uploads aren't available right now. Please try again later.");
  return s;
}

/** Saves a new file and retires the one it replaces (its stored copy is deleted). */
async function saveDocument(owner: { playerId: string } | { userId: string }, kind: DocKind, seasonId: string | null, buf: Buffer, uploadedBy: string) {
  const store = storeOrFail();
  const { data, contentType } = await prepareFile(kind, buf);
  const storageKey = `${kind}/${randomUUID()}`;
  await store.put(storageKey, data, contentType);
  const ownerCol = "playerId" in owner ? documents.playerId : documents.userId;
  const ownerId = "playerId" in owner ? owner.playerId : owner.userId;
  let old: Doc[] = [];
  let saved: Doc;
  try {
    saved = await db.transaction(async (tx) => {
      // One upload at a time per person/child and kind.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`doc:${kind}:${ownerId}`}))`);
      old = await tx
        .update(documents)
        .set({ replacedAt: new Date() })
        .where(and(eq(documents.kind, kind), eq(ownerCol, ownerId), seasonId ? eq(documents.seasonId, seasonId) : isNull(documents.seasonId), isNull(documents.replacedAt)))
        .returning();
      const [row] = await tx
        .insert(documents)
        .values({ kind, ...owner, seasonId, storageKey, contentType, sizeBytes: data.length, uploadedBy })
        .returning();
      await writeAudit(tx, { actorUserId: uploadedBy, action: old.length ? "document.replace" : "document.upload", targetType: "document", targetId: row!.id, after: { kind, ...owner, seasonId, sizeBytes: data.length } });
      return row!;
    });
  } catch (err) {
    await store.remove(storageKey).catch(() => undefined);
    throw err;
  }
  for (const o of old) {
    await store.remove(o.storageKey).catch((err) => logger.warn({ key: o.storageKey, err: String(err) }, "couldn't delete a replaced upload"));
  }
  return saved;
}

/* ---------------- children ---------------- */

async function assertFamily(userId: string, playerId: string) {
  const [p] = await db
    .select({ id: players.id })
    .from(players)
    .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
    .where(and(eq(players.id, playerId), eq(householdMembers.userId, userId)));
  if (!p) throw new HttpError(404, "NOT_FOUND", "Player not found.");
}

/** The child's current files that count for a season. */
export async function playerDocs(playerId: string, seasonId: string | null) {
  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.playerId, playerId), isNull(documents.replacedAt)));
  const out: Partial<Record<PlayerKind, Doc>> = {};
  for (const k of PLAYER_KINDS) {
    out[k] = rows.find((r) => r.kind === k && (KIND_INFO[k].perSeason ? r.seasonId === seasonId : r.seasonId === null));
  }
  return out;
}

export async function missingForPlayer(playerId: string, seasonId: string) {
  const docs = await playerDocs(playerId, seasonId);
  return PLAYER_KINDS.filter((k) => !docs[k]);
}

/** Throws before payment if the child's files aren't all in (only while the switch is on). */
export async function requirePlayerDocs(playerId: string, seasonId: string) {
  if (!(await documentsRequired())) return;
  const missing = await missingForPlayer(playerId, seasonId);
  if (missing.length) {
    throw new HttpError(409, "CONFLICT", `Upload the ${listOf(missing.map((k) => KIND_INFO[k].label.toLowerCase()))} before paying.`, { missingDocuments: missing });
  }
}

const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

const docView = (d: Doc | undefined) => (d ? { id: d.id, contentType: d.contentType, uploadedAt: d.createdAt, url: `/api/v1/documents/${d.id}/file` } : null);

/**
 * Files the family can no longer change themselves, once the league has
 * accepted the child: the birth certificate (after any accepted registration)
 * and that season's headshot. The insurance card can always be updated.
 * Admins change locked files from the registration page.
 */
export async function lockedKinds(playerId: string, seasonId: string | null): Promise<Set<PlayerKind>> {
  const approved = await db
    .select({ seasonId: registrations.seasonId })
    .from(registrations)
    .where(and(eq(registrations.playerId, playerId), eq(registrations.status, "approved")));
  const locked = new Set<PlayerKind>();
  if (approved.length) locked.add("birth_certificate");
  if (seasonId && approved.some((r) => r.seasonId === seasonId)) locked.add("player_photo");
  return locked;
}

/** What a family sees for one child: each required file, whether it's in for the current season, and whether they can still change it. */
export async function familyDocuments(userId: string, playerId: string) {
  await assertFamily(userId, playerId);
  const seasonId = await currentSeasonId();
  const docs = await playerDocs(playerId, seasonId);
  const locked = await lockedKinds(playerId, seasonId);
  return {
    required: await documentsRequired(),
    items: PLAYER_KINDS.map((k) => ({
      kind: k,
      label: KIND_INFO[k].label,
      perSeason: KIND_INFO[k].perSeason,
      // Locked only once there's something on file (a missing file can still be added).
      locked: locked.has(k) && !!docs[k],
      document: docView(docs[k]),
    })),
  };
}

export async function uploadPlayerDocument(userId: string, playerId: string, kind: PlayerKind, buf: Buffer) {
  await assertFamily(userId, playerId);
  const seasonId = KIND_INFO[kind].perSeason ? await currentSeasonId() : null;
  if (KIND_INFO[kind].perSeason && !seasonId) throw new HttpError(409, "CONFLICT", "Uploads open when the season is set up.");
  if ((await lockedKinds(playerId, seasonId)).has(kind) && (await playerDocs(playerId, seasonId))[kind]) {
    throw new HttpError(409, "CONFLICT", `The league has accepted this registration, so the ${KIND_INFO[kind].label.toLowerCase()} can only be changed by the league. Contact the league to update it.`);
  }
  return docView(await saveDocument({ playerId }, kind, seasonId, buf, userId));
}

/** Admins can replace any of a child's files, for the registration's season. */
export async function adminUploadPlayerDocument(actorUserId: string, registrationId: string, kind: PlayerKind, buf: Buffer) {
  const [r] = await db.select({ playerId: registrations.playerId, seasonId: registrations.seasonId }).from(registrations).where(eq(registrations.id, registrationId));
  if (!r) throw new HttpError(404, "NOT_FOUND", "Registration not found.");
  return docView(await saveDocument({ playerId: r.playerId }, kind, KIND_INFO[kind].perSeason ? r.seasonId : null, buf, actorUserId));
}

/* ---------------- staff and referee headshots ---------------- */

export async function staffPhoto(userId: string, seasonId: string | null) {
  if (!seasonId) return undefined;
  const [d] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.kind, "staff_photo"), eq(documents.seasonId, seasonId), isNull(documents.replacedAt)));
  return d;
}

export async function myPhoto(userId: string) {
  return { required: await documentsRequired(), document: docView(await staffPhoto(userId, await currentSeasonId())) };
}

export async function uploadMyPhoto(userId: string, buf: Buffer) {
  const seasonId = await currentSeasonId();
  if (!seasonId) throw new HttpError(409, "CONFLICT", "Uploads open when the season is set up.");
  return docView(await saveDocument({ userId }, "staff_photo", seasonId, buf, userId));
}

/** Throws if the person's headshot for the season isn't in (only while the switch is on). */
export async function requireStaffPhoto(userId: string, seasonId: string, what: string) {
  if (!(await documentsRequired())) return;
  if (!(await staffPhoto(userId, seasonId))) {
    throw new HttpError(409, "CONFLICT", `Upload your headshot before ${what}.`, { missingDocuments: ["staff_photo"] });
  }
}

/* ---------------- viewing ---------------- */

/**
 * Who may open a file:
 *   - the child's family / the person themselves;
 *   - admins with documents.read (views of birth certificates and insurance cards are logged);
 *   - a child's headshot: coaches of a team the child is on that season;
 *   - a staff headshot: admins who review coaches or referees.
 */
async function mayView(viewer: { userId: string; access: Access }, d: Doc): Promise<"own" | "admin" | "coach" | null> {
  if (d.userId && d.userId === viewer.userId) return "own";
  if (d.playerId) {
    const [fam] = await db
      .select({ id: players.id })
      .from(players)
      .innerJoin(householdMembers, eq(householdMembers.householdId, players.householdId))
      .where(and(eq(players.id, d.playerId), eq(householdMembers.userId, viewer.userId)));
    if (fam) return "own";
  }
  if (can(viewer.access, "documents.read")) return "admin";
  if (d.kind === "staff_photo" && (can(viewer.access, "staff.applications.review") || can(viewer.access, "referees.manage"))) return "admin";
  if (d.kind === "player_photo" && d.playerId && d.seasonId) {
    const onTeams = await db
      .select({ teamId: rosterEntries.teamId })
      .from(rosterEntries)
      .innerJoin(teams, eq(teams.id, rosterEntries.teamId))
      .where(and(eq(rosterEntries.playerId, d.playerId), eq(teams.seasonId, d.seasonId)));
    if (onTeams.some((t) => can(viewer.access, "roster.read", { type: "team", id: t.teamId }))) return "coach";
  }
  return null;
}

export async function readDocument(viewer: { userId: string; access: Access; requestId?: string; ip?: string }, id: string) {
  const [d] = await db.select().from(documents).where(eq(documents.id, id));
  // Same answer whether it doesn't exist or isn't yours.
  if (!d || d.replacedAt) throw new HttpError(404, "NOT_FOUND", "File not found.");
  const who = await mayView(viewer, d);
  if (!who) throw new HttpError(404, "NOT_FOUND", "File not found.");
  if (who !== "own" && KIND_INFO[d.kind as DocKind].sensitive) {
    await writeAudit(db, { actorUserId: viewer.userId, action: "document.view", targetType: "document", targetId: d.id, after: { kind: d.kind, playerId: d.playerId }, requestId: viewer.requestId, ipAddress: viewer.ip });
  }
  const data = await storeOrFail().get(d.storageKey);
  return { data, contentType: d.contentType, kind: d.kind as DocKind };
}

/** Current headshot ids for many children in one season (coach roster, admin lists). */
export async function playerPhotoIds(playerIds: string[], seasonId: string) {
  if (!playerIds.length) return new Map<string, string>();
  const rows = await db
    .select({ id: documents.id, playerId: documents.playerId })
    .from(documents)
    .where(and(inArray(documents.playerId, playerIds), eq(documents.kind, "player_photo"), eq(documents.seasonId, seasonId), isNull(documents.replacedAt)));
  return new Map(rows.map((r) => [r.playerId!, r.id]));
}

/** For admin pages: a child's files for a season, with links. */
export async function adminPlayerDocuments(playerId: string, seasonId: string) {
  const docs = await playerDocs(playerId, seasonId);
  return PLAYER_KINDS.map((k) => ({ kind: k, label: KIND_INFO[k].label, document: docView(docs[k]) }));
}

export async function adminStaffPhoto(userId: string, seasonId: string) {
  return docView(await staffPhoto(userId, seasonId));
}
