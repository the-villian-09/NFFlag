/** Public league info: current season and its open divisions. */
import { and, asc, eq, ne } from "drizzle-orm";
import { Router } from "express";
import { db } from "../../db/client.js";
import { divisions, seasons } from "../../db/schema/index.js";
import { handler } from "../../http/context.js";
import { HttpError } from "../../http/errors.js";

export const leagueRouter = Router();

leagueRouter.get(
  "/seasons/current",
  handler(async (_req, res) => {
    const [season] = await db.select().from(seasons).where(eq(seasons.isCurrent, "current")).limit(1);
    if (!season) throw new HttpError(404, "NOT_FOUND", "No current season.");
    const divs = await db
      .select({
        id: divisions.id,
        name: divisions.name,
        genderPolicy: divisions.genderPolicy,
        birthDateFrom: divisions.birthDateFrom,
        birthDateTo: divisions.birthDateTo,
        eligibilityNotes: divisions.eligibilityNotes,
        priceCents: divisions.priceCents,
        status: divisions.status,
      })
      .from(divisions)
      .where(and(eq(divisions.seasonId, season.id), ne(divisions.status, "draft")))
      .orderBy(asc(divisions.sortOrder), asc(divisions.name));
    res.set("cache-control", "public, max-age=60");
    res.json({
      season: {
        id: season.id,
        name: season.name,
        year: season.year,
        status: season.status,
        registrationOpensAt: season.registrationOpensAt,
        registrationClosesAt: season.registrationClosesAt,
      },
      divisions: divs,
    });
  }),
);
