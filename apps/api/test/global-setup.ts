/** Wipes the test database, applies all migrations and seeds the platform. */
export default async function setup() {
  await import("./env.js");
  const { pool } = await import("../src/db/client.js");
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations();
  const { seedPlatform, seedSample } = await import("../src/db/seed.js");
  await seedPlatform();
  await seedSample();
  await pool.end();
}
