/**
 * Applies SQL migrations in ./drizzle. Run as a Cloud Run job before each
 * deploy (see infra/README.md), never on app startup.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, pool } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

export async function runMigrations() {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log("Migrations applied");
      return pool.end();
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
