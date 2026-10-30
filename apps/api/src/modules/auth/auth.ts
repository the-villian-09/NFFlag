/**
 * Authentication: email + password, password reset, sessions, and optional
 * two-step sign-in (emailed code or authenticator app, user's choice).
 * A role can be set to require an authenticator app (roles.requires_totp,
 * off by default) without a code change.
 *
 * Mounted at /api/auth/* (Vercel proxies the browser's /api/* to Cloud Run,
 * so cookies are first-party on APP_BASE_URL).
 *
 * BACKLOG — Google / Microsoft sign-in: add `socialProviders` here, e.g.
 *   socialProviders: {
 *     google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
 *     microsoft: { clientId: ..., clientSecret: ..., tenantId: "common" },
 *   }
 * gated by the `auth.google` / `auth.microsoft` feature flags in the UI.
 * Users, roles and MFA policy are unchanged: a provider login is one more
 * row in the `account` table for the same user.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq } from "drizzle-orm";
import { env } from "../../config.js";
import { db } from "../../db/client.js";
import * as schema from "../../db/schema/index.js";
import { getEmailSender } from "../../lib/email.js";
import { templates } from "../../lib/email-templates.js";
import { logger } from "../../lib/logger.js";
import { loadAccess } from "../platform/access.js";
import { publish } from "../platform/outbox.js";

const ONE_DAY = 60 * 60 * 24;

export const auth = betterAuth({
  appName: "NFFL",
  baseURL: env.APP_BASE_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_BASE_URL],

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      twoFactor: schema.twoFactor,
      rateLimit: schema.rateLimit,
    },
  }),

  user: {
    additionalFields: {
      status: { type: "string", required: false, defaultValue: "active", input: false },
      locale: { type: "string", required: false, defaultValue: "en", input: true },
    },
  },

  emailAndPassword: {
    enabled: true,
    // Decision (Oct 30): accounts are usable right after sign-up; no email confirmation step.
    requireEmailVerification: false,
    autoSignIn: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await getEmailSender().send(templates.resetPassword(user.email, url));
    },
  },

  // Not sent at sign-up. Kept configured so a later release can ask a family to
  // confirm their address (e.g. before checkout) without new plumbing.
  emailVerification: {
    sendOnSignUp: false,
    autoSignInAfterVerification: true,
    expiresIn: ONE_DAY,
    sendVerificationEmail: async ({ user, url }) => {
      await getEmailSender().send(templates.verifyEmail(user.email, url));
    },
  },

  session: {
    expiresIn: 7 * ONE_DAY,
    updateAge: ONE_DAY,
  },

  rateLimit: {
    enabled: env.NODE_ENV !== "test",
    storage: "database",
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/two-factor/send-otp": { window: 60, max: 3 },
      "/two-factor/verify-otp": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 5 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
    },
  },

  advanced: {
    cookiePrefix: "nffl",
    useSecureCookies: env.NODE_ENV === "production",
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
  },

  plugins: [
    twoFactor({
      issuer: "NFFL",
      trustDeviceMaxAge: 30 * ONE_DAY,
      backupCodeOptions: { amount: 10, length: 10 },
      otpOptions: {
        period: 10, // minutes
        storeOTP: "hashed",
        allowedAttempts: 5,
        async sendOTP({ user, otp }) {
          // If one of the user's roles is set to require an authenticator app,
          // email codes are not accepted for that account.
          const access = await loadAccess(db, user.id);
          if (access.requiresTotp) {
            logger.warn({ userId: user.id }, "email code refused: role requires authenticator app");
            return;
          }
          await getEmailSender().send(templates.loginCode(user.email, otp));
        },
      },
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await publish(db, {
            name: "user.registered",
            aggregateType: "user",
            aggregateId: user.id,
            dedupeKey: `user.registered:${user.id}`,
          });
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const [u] = await db
            .select({ status: schema.user.status })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId))
            .limit(1);
          if (u?.status === "disabled") {
            throw new APIError("FORBIDDEN", { message: "This account is disabled. Contact the league office." });
          }
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
