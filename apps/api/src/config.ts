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

  /* Uploaded documents and photos. Staging/production: a private Cloud Storage
     bucket (the API's service account reads and writes it). Local dev and
     tests: a folder on disk. */
  UPLOADS_BUCKET: z.string().optional(),
  UPLOADS_DIR: z.string().default(".uploads"),

  /**
   * Shared secret the website adds to every request it forwards to the API
   * (apps/web/proxy.ts and server-side fetches). When set, the API refuses
   * requests without it (except health checks and payment webhooks), so the
   * Cloud Run address can't be called directly and the visitor IP the website
   * passes on can be trusted. Set with infra/set-proxy-secret.sh.
   */
  API_PROXY_SECRET: z.string().min(32).optional(),

  /**
   * Cloudflare Turnstile secret key (the invisible "are you human" check).
   * When set, sign-up, password reset, resend-confirmation and the contact
   * form need a passing check from the website's widget (whose site key is
   * NEXT_PUBLIC_TURNSTILE_SITE_KEY in Vercel). Set with infra/set-turnstile.sh.
   */
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  // A production build must say which environment it is; defaulting to "dev"
  // would turn on local-only behaviour (uploads on disk, emails in the log).
  if (parsed.data.NODE_ENV === "production" && !source.APP_ENV) {
    throw new Error("Invalid environment: APP_ENV must be set (staging or prod) when NODE_ENV=production");
  }
  return parsed.data;
}

export const env = loadEnv();
