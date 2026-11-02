import { z } from "zod";

/** Request/response contracts shared by web and API. Add new ones per module. */

export const signUpInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
});
export type SignUpInput = z.infer<typeof signUpInput>;

/** Optional text a user can clear: "" becomes null (cleared), missing stays undefined (unchanged). */
const clearable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "" ? null : v));

export const householdInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  phone: clearable(32),
  addressLine1: clearable(200),
  city: clearable(100),
  state: z
    .union([z.literal(""), z.string().trim().regex(/^[A-Za-z]{2}$/, "Use the 2-letter state code")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "" ? null : v.toUpperCase())),
  postalCode: z
    .union([z.literal(""), z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Use a 5-digit ZIP code")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "" ? null : v)),
});
export type HouseholdInput = z.infer<typeof householdInput>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/** A child's profile. Medical and emergency details are stored separately and access-restricted. */
export const playerInput = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  preferredName: optionalText(60),
  birthDate: z.iso.date(),
  gender: z.enum(["boy", "girl"]),
  shirtSize: optionalText(20),
  school: optionalText(120),
  grade: optionalText(20),
  medical: z.object({
    allergies: optionalText(1000),
    medicalConditions: optionalText(1000),
    medications: optionalText(1000),
    medicalInstructions: optionalText(2000),
    physicianName: optionalText(120),
    physicianPhone: optionalText(32),
    emergencyContactName: z.string().trim().min(1).max(120),
    emergencyContactPhone: z.string().trim().min(7).max(32),
    emergencyContactRelationship: optionalText(60),
  }),
});
export type PlayerInput = z.infer<typeof playerInput>;

export const startRegistrationInput = z.object({
  playerId: z.uuid(),
  divisionId: z.uuid(),
  /** Typed full name of the parent/guardian signing the waivers. */
  signerName: z.string().trim().min(3).max(120),
  /** Slugs of the waivers the parent ticked; must cover every required waiver. */
  acceptedWaivers: z.array(z.string()).max(10),
});
export type StartRegistrationInput = z.infer<typeof startRegistrationInput>;

export const joinWaitlistInput = z.object({ playerId: z.uuid(), divisionId: z.uuid() });

export const acceptOfferInput = z.object({
  signerName: z.string().trim().min(3).max(120),
  acceptedWaivers: z.array(z.string()).max(10),
});

export const volunteerApplicationInput = z.object({
  roleKey: z.enum(["head_coach", "assistant_coach", "team_manager"]),
  preferredDivisionId: z.uuid().optional(),
  playerId: z.uuid().optional(),
  phone: z.string().trim().min(7).max(32),
  experience: optionalText(2000),
  notes: optionalText(1000),
  shirtSize: optionalText(20),
  signerName: z.string().trim().min(3).max(120),
  acceptAgreement: z.boolean(),
});

export const payRegistrationInput = z.object({
  /** Stripe ConfirmationToken id (ctoken_…) or Square card nonce. Left out when the total is $0 (e.g. a 100% promo code). */
  sourceId: z.string().min(1).max(500).optional(),
  verificationToken: z.string().max(2000).optional(),
  /** The total the family saw. If it no longer matches, nothing is charged and the new total is returned. */
  expectedTotalCents: z.number().int().min(0).optional(),
});

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

/** Domain event names published to the outbox. Subscribers attach later. */
export const DOMAIN_EVENTS = [
  "user.registered",
  "user.mfa_enrolled",
  "user.mfa_reset",
  "household.created",
  "registration.submitted",
  "registration.paid",
  "registration.cancelled",
  "registration.refunded",
  "registration.withdrawal_requested",
  "registration.withdrawal_declined",
  "eligibility.decided",
  "square.connected",
  "waitlist.joined",
  "waitlist.offered",
  "waitlist.offer_expired",
  "staff.application_submitted",
  "staff.application_decided",
  "staff.application_refunded",
  "roster.published",
  "roster.notify",
  "announcement.sent",
  "referee.application_submitted",
  "referee.application_decided",
  "referee.assigned",
  "referee.unassigned",
  "referee.paid",
  "referee.game_changed",
  "square.disconnected",
] as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[number];
