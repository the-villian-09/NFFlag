import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** dev | staging | prod — used for logs and the email subject prefix. */
  APP_ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
  PORT: z.coerce.number().default(8080),
  /**
   * Postgres connection string. On Cloud Run with Cloud SQL use the socket form:
   * postgres://USER:PASS@/DBNAME?host=/cloudsql/PROJECT:REGION:INSTANCE
   */
  DATABASE_URL: z.string().min(1),
  /** 32+ random bytes; stored in Secret Manager. Rotating it signs everyone out. */
  BETTER_AUTH_SECRET: z.string().min(32),
  /**
   * Public origin the browser uses (the Vercel front end). Vercel proxies
   * /api/* to Cloud Run, so auth cookies are first-party on this origin.
   */
  APP_BASE_URL: z.url(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("NFFL <no-reply@example.com>"),
  /** Admin portal idle timeout in minutes. */
  ADMIN_IDLE_MINUTES: z.coerce.number().default(30),
  LOG_LEVEL: z.string().default("info"),

  /* Square (R1b). Staging uses the Sandbox; production connects the league's own
     Square account through OAuth (Admin → Payments → Connect Square). */
  SQUARE_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  /** Developer app id (public; also used by the card form in the browser). */
  SQUARE_APPLICATION_ID: z.string().optional(),
  /** OAuth client secret of the developer app. Needed for Connect/Disconnect. */
  SQUARE_APPLICATION_SECRET: z.string().optional(),
  /**
   * Sandbox only: the developer app's Sandbox access token, used when no account
   * has been connected through OAuth. Ignored in production.
   */
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  /** Location to charge with SQUARE_ACCESS_TOKEN (Sandbox fallback only). */
  SQUARE_LOCATION_ID: z.string().optional(),
  /** Signature key of the webhook subscription in the Square developer dashboard. */
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),

  /* Stripe (main payment provider; Square is the backup). Test keys (sk_test_/pk_test_)
     on staging, the league's live keys in production. */
  /** Secret key (sk_test_… / sk_live_…, or a restricted rk_ key). */
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Publishable key for the card form in the browser (pk_test_… / pk_live_…). */
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  /** Signing secret of the webhook endpoint in the Stripe dashboard (whsec_…). */
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();
