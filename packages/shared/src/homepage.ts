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
