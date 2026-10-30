import { sql } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { handler } from "../../http/context.js";
import { getFlags } from "./flags.js";

export const platformRouter = Router();

/** Liveness: process is up. */
platformRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Readiness: database reachable. Cloud Run startup probe points here. */
platformRouter.get(
  "/ready",
  handler(async (_req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  }),
);

/** Enabled feature flags, so the front end can show/hide released features. */
platformRouter.get(
  "/flags",
  handler(async (_req, res) => {
    const flags = await getFlags();
    res.set("cache-control", "public, max-age=15");
    res.json({ enabled: [...flags].filter(([, on]) => on).map(([key]) => key) });
  }),
);
