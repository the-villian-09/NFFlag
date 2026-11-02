import { z } from "zod";

/** Homepage facts the league edits in Admin → Site content → Homepage. Plain text, shown as typed. */
const text = (max: number) => z.string().trim().max(max);
const pair = z.object({ label: text(40), value: text(60) });

export const homepageSchema = z.object({
  /** Hero button, e.g. "Register · Dec 1 – Jan 3". */
  registerButton: text(60).min(1),
  tagline: text(120),
  boysAgeRange: text(40),
  girlsAgeRange: text(40),
  /** The lime band under the hero (up to 6). */
  keyDates: z.array(pair).max(6),
  practiceDays: text(80),
  practiceTimes: text(80),
  gameDays: text(80),
  gameDates: text(80),
  boysDivisions: z.array(text(20).min(1)).max(16),
  girlsDivisions: z.array(text(20).min(1)).max(16),
  registrationFee: text(20),
  registrationFeeNote: text(40),
  leagueFees: z.array(pair).max(6),
  gateFees: z.array(pair).max(6),
  ctaTitle: text(60),
  ctaText: text(160),
});
export type Homepage = z.infer<typeof homepageSchema>;

/** From the 2027 season flyer. */
export const DEFAULT_HOMEPAGE: Homepage = {
  registerButton: "Register · Dec 1 – Jan 3",
  tagline: "Boys and girls · Football · Fun · Development · Community",
  boysAgeRange: "4U/5U – 12U",
  girlsAgeRange: "4U/5U – 14U",
  keyDates: [
    { label: "Registration", value: "Dec 1 – Jan 3" },
    { label: "Draft", value: "Jan 4, 2027" },
    { label: "First practice", value: "Jan 6, 2027" },
    { label: "Championship", value: "April 3 – 4" },
  ],
  practiceDays: "Monday – Wednesday",
  practiceTimes: "6:00 – 7:30 PM",
  gameDays: "Tuesday · Thursday · Saturday",
  gameDates: "February 2 – March 27",
  boysDivisions: ["4U/5U", "6U", "7U", "8U", "9U", "10U", "11U", "12U"],
  girlsDivisions: ["4U/5U", "6U", "7U", "8U", "9U", "10U", "11U", "12U", "14U"],
  registrationFee: "$100",
  registrationFeeNote: "Per player",
  leagueFees: [
    { label: "Coaching badge", value: "$25" },
    { label: "Team mom", value: "$25" },
  ],
  gateFees: [
    { label: "Adults", value: "$7" },
    { label: "Kids", value: "$4" },
    { label: "4 and under", value: "Free" },
  ],
  ctaTitle: "More than a league",
  ctaText: "We build players, leaders and a stronger North Florida.",
};

/* ---------------- in-season home page ---------------- */

const httpsOrBlank = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "Links must start with https://");

export const sponsorSchema = z.object({
  name: text(60).min(1),
  url: httpsOrBlank,
  /** An uploaded logo (Site content → Photos). */
  logoId: z.uuid().nullable().default(null),
});

/**
 * The home page once the season is under way (Admin → Site content →
 * In-season home page). Scores, standings and the next game day come from
 * the schedule; everything here is wording and what to show.
 */
export const seasonHomeSchema = z.object({
  /** auto: in-season page while the current season is "in season" or "playoffs". */
  mode: z.enum(["auto", "registration", "season"]),
  heroKicker: text(40),
  /** Green status pill on the hero; blank hides it. */
  statusText: text(60),
  /** Where games are; blank lists the fields from the schedule. */
  whereText: text(80),
  passesLabel: text(40).min(1),
  ticketsLabel: text(40).min(1),
  /** Day tickets on TixFlo; blank hides the button. */
  ticketsUrl: httpsOrBlank,
  /** Shown when no games are coming up. */
  noGamesTitle: text(60).min(1),
  noGamesText: text(200),
  showYourTeam: z.boolean(),
  showScores: z.boolean(),
  scoresTitle: text(40).min(1),
  showStandings: z.boolean(),
  standingsTitle: text(40).min(1),
  /** Teams that make the playoffs per division; 0 hides the playoff race panel. */
  playoffSpots: z.number().int().min(0).max(16),
  playoffNote: text(160),
  showNews: z.boolean(),
  newsTitle: text(40).min(1),
  showSponsors: z.boolean(),
  sponsorsTitle: text(60).min(1),
  sponsors: z.array(sponsorSchema).max(16),
});
export type SeasonHome = z.infer<typeof seasonHomeSchema>;
export type Sponsor = z.infer<typeof sponsorSchema>;

export const DEFAULT_SEASON_HOME: SeasonHome = {
  mode: "auto",
  heroKicker: "Next game day",
  statusText: "Games on as scheduled",
  whereText: "",
  passesLabel: "Buy season passes",
  ticketsLabel: "Buy day tickets",
  ticketsUrl: "",
  noGamesTitle: "See you next season",
  noGamesText: "Thanks for a great season. Check back for next season's dates.",
  showYourTeam: true,
  showScores: true,
  scoresTitle: "Latest scores",
  showStandings: true,
  standingsTitle: "Standings",
  playoffSpots: 0,
  playoffNote: "",
  showNews: true,
  newsTitle: "League news",
  showSponsors: false,
  sponsorsTitle: "Thanks to our sponsors",
  sponsors: [],
};

/* ---------------- replaceable photos ---------------- */

/** Home page pictures an admin can replace. Without an upload the built-in photo is used. */
export const IMAGE_SLOTS = {
  heroBoy: { label: "Registration home: boys side (top)", fallback: "/images/hero-boy.jpg", hint: "Tall or square photo; the player should be near the middle." },
  heroGirl: { label: "Registration home: girls side (top)", fallback: "/images/hero-girl.jpg", hint: "Tall or square photo; the player should be near the middle." },
  divisionBoys: { label: "Registration home: boys divisions", fallback: "/images/division-boys.jpg", hint: "Wide photo." },
  divisionGirls: { label: "Registration home: girls divisions", fallback: "/images/division-girls.jpg", hint: "Wide photo." },
  seasonLeft: { label: "In-season home: left photo", fallback: "/images/hero-boy.jpg", hint: "Game-day action photo. Text sits on top of this side, so it's darkened." },
  seasonRight: { label: "In-season home: right photo", fallback: "/images/hero-girl.jpg", hint: "Game-day action photo." },
} as const;
export type ImageSlot = keyof typeof IMAGE_SLOTS;
export const IMAGE_SLOT_KEYS = Object.keys(IMAGE_SLOTS) as ImageSlot[];

export const imageSlotsSchema = z.object(Object.fromEntries(IMAGE_SLOT_KEYS.map((k) => [k, z.uuid().nullable().default(null)])) as Record<ImageSlot, z.ZodDefault<z.ZodNullable<z.ZodUUID>>>);
export type ImageSlots = Record<ImageSlot, string | null>;
export const DEFAULT_IMAGE_SLOTS: ImageSlots = Object.fromEntries(IMAGE_SLOT_KEYS.map((k) => [k, null])) as ImageSlots;

/** Public address of an uploaded photo. */
export const siteImageUrl = (id: string) => `/api/v1/site-images/${id}`;
