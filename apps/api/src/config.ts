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
