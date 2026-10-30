/**
 * Email diagnostic. Sends one test message through the configured provider
 * and prints exactly what happened. Never prints the API key itself.
 *
 *   node dist/scripts/send-test-email.js you@example.com
 *
 * On Cloud Run (uses the same secrets as the API):
 *   gcloud run jobs execute nffl-migrate-staging --region=us-east1 --wait \
 *     --args="-c,node dist/scripts/send-test-email.js you@example.com"
 */
import { Resend } from "resend";
import { env } from "../config.js";

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes("@")) throw new Error("Usage: send-test-email <to-address>");

  const key = env.RESEND_API_KEY ?? "";
  const trimmed = key.trim();
  console.log(`APP_ENV=${env.APP_ENV} NODE_ENV=${env.NODE_ENV}`);
  console.log(`EMAIL_FROM=${env.EMAIL_FROM}`);
  if (!key) {
    console.log("RESULT: RESEND_API_KEY is NOT set for this service/job. Emails go to the log only.");
    process.exitCode = 2;
    return;
  }
  console.log(
    `RESEND_API_KEY: present, ${key.length} chars, starts with "${key.slice(0, 3)}"` +
      (trimmed !== key ? " — WARNING: has leading/trailing spaces or newlines" : "") +
      (key.startsWith("re_") ? "" : " — WARNING: Resend keys start with re_"),
  );

  const client = new Resend(trimmed);
  const { data, error } = await client.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject: `[${env.APP_ENV}] NFFL test email`,
    text: `This is a test email from the NFFL ${env.APP_ENV} API. If you received it, email sending works.`,
  });
  if (error) {
    console.log(`RESULT: Resend REJECTED the email: ${error.name ?? ""} ${error.message}`);
    process.exitCode = 3;
    return;
  }
  console.log(`RESULT: accepted by Resend, id ${data?.id}. Check the Emails page in Resend and your inbox/spam.`);
}

main().catch((err) => {
  console.log(`RESULT: failed before reaching Resend: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
