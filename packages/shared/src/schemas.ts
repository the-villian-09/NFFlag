import { z } from "zod";

/** Request/response contracts shared by web and API. Add new ones per module. */

export const signUpInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
});
export type SignUpInput = z.infer<typeof signUpInput>;

export const householdInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().length(2).optional(),
  postalCode: z.string().trim().max(10).optional(),
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

export const payRegistrationInput = z.object({
  /** Card token (nonce) from the Square Web Payments SDK. */
  sourceId: z.string().min(1).max(500),
  verificationToken: z.string().max(2000).optional(),
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
  "eligibility.decided",
  "square.connected",
  "square.disconnected",
] as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[number];
