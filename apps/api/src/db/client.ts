import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config.js";
import * as schema from "./schema/index.js";

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
/** A transaction handle; module services accept `Db | Tx` so callers can compose them. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
