/**
 * Creates (or updates) the database login the running app uses: it can read
 * and write rows, but can't create, change or drop tables, create roles or
 * databases (security audit M10). Migrations keep using the owner login.
 *
 * Run once per environment by infra/harden-gcp.sh, through the migrate job:
 *   node dist/db/runtime-role.js
 * with DATABASE_URL = the owner login (as for migrations) and
 * DATABASE_URL_RUNTIME = the new login's connection string (from Secret Manager).
 * Safe to re-run (it also picks up tables added since).
 */
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./client.js";

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function runtimeLogin(url: string) {
  // Read the user and password directly: Cloud SQL socket URLs
  // ("postgres://user:pass@/db?host=/cloudsql/...") have no host, which URL() rejects.
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@/]+):([^@]*)@/);
  if (!m) throw new Error("DATABASE_URL_RUNTIME should look like postgres://user:password@...");
  const user = decodeURIComponent(m[1]!);
  const password = decodeURIComponent(m[2]!);
  if (!/^[a-z_][a-z0-9_]{2,62}$/.test(user)) throw new Error("DATABASE_URL_RUNTIME needs a simple user name (letters, numbers, underscores).");
  if (password.length < 24) throw new Error("DATABASE_URL_RUNTIME needs a long password.");
  return { user, password };
}

export async function ensureRuntimeRole(client: pg.PoolClient, url: string) {
  const { user, password } = runtimeLogin(url);
  const owner = (await client.query<{ owner: string }>("select current_user as owner")).rows[0]!.owner;
  if (user === owner) throw new Error("The runtime login must be different from the migration (owner) login.");
  const exists = (await client.query("select 1 from pg_roles where rolname = $1", [user])).rowCount;
  const role = ident(user);
  await client.query("begin");
  try {
    if (!exists) await client.query(`create role ${role} login password ${literal(password)}`);
    else await client.query(`alter role ${role} login password ${literal(password)}`);
    await client.query(`alter role ${role} nosuperuser nocreatedb nocreaterole noinherit`);
    // Cloud SQL may have added the login to cloudsqlsuperuser; take that back if so.
    const elevated = (await client.query("select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where r.rolname = 'cloudsqlsuperuser' and u.rolname = $1", [user])).rowCount;
    if (elevated) await client.query(`revoke cloudsqlsuperuser from ${role}`);
    const db = (await client.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
    await client.query(`grant connect on database ${ident(db)} to ${role}`);
    await client.query(`revoke create on schema public from ${role}`);
    await client.query(`grant usage on schema public to ${role}`);
    await client.query(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await client.query(`grant usage, select, update on all sequences in schema public to ${role}`);
    // Tables and sequences that later migrations create.
    await client.query(`alter default privileges for role ${ident(owner)} in schema public grant select, insert, update, delete on tables to ${role}`);
    await client.query(`alter default privileges for role ${ident(owner)} in schema public grant usage, select, update on sequences to ${role}`);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
  return { user, owner };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    const url = process.env.DATABASE_URL_RUNTIME;
    if (!url) throw new Error("DATABASE_URL_RUNTIME is not set.");
    const client = await pool.connect();
    try {
      const r = await ensureRuntimeRole(client, url);
      console.log(`Runtime login "${r.user}" ready (row access only; tables owned by "${r.owner}").`);
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
