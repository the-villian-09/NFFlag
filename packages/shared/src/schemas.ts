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
  "eligibility.decided",
] as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[number];
