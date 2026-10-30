/**
 * Bootstrap the first Super Admins (the admin UI needs one to exist).
 * The person signs up normally first, then:
 *
 *   pnpm --filter @nffl/api exec tsx src/scripts/grant-role.ts you@example.com super_admin
 *
 * Writes an audit entry with actor = null (system).
 */
import { ROLE_KEYS, type RoleKey } from "@nffl/shared";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { user, userRoleAssignments } from "../db/schema/index.js";
import { writeAudit } from "../modules/platform/audit.js";

async function main() {
  const [email, role] = process.argv.slice(2);
  if (!email || !role || !(ROLE_KEYS as readonly string[]).includes(role)) {
    throw new Error(`Usage: grant-role <email> <${ROLE_KEYS.join("|")}>`);
  }
  const [u] = await db.select().from(user).where(eq(user.email, email.toLowerCase()));
  if (!u) throw new Error(`No user with email ${email}. They must sign up first.`);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(userRoleAssignments)
      .values({ userId: u.id, roleKey: role as RoleKey })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      console.log(`${email} already has ${role}`);
      return;
    }
    await writeAudit(tx, {
      actorUserId: null,
      action: "role.grant",
      targetType: "user",
      targetId: u.id,
      after: row,
      reason: "bootstrap via grant-role script",
    });
    console.log(`Granted ${role} to ${email}. It takes effect the next time they load a page.`);
  });
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
