import { DEFAULT_HOMEPAGE, DEFAULT_IMAGE_SLOTS, DEFAULT_SEASON_HOME, type Homepage, type ImageSlots, type SeasonHome } from "@nffl/shared";
/**
 * Starting text for the public pages. Facts come from the 2027 season flyer;
 * anything not yet supplied by the league is a [BRACKETED PLACEHOLDER].
 * Seeded once (never overwrites an admin's edits). Privacy and Terms are
 * drafts that must be reviewed by counsel before launch.
 */

export interface DefaultPage {
  slug: string;
  title: string;
  body: string;
}

export const PAGE_SLUGS = [
  "about",
  "rules",
  "coaches",
  "faq",
  "contact",
  "privacy",
  "terms",
  "waiver-liability",
  "waiver-medical",
  "waiver-media",
  "volunteer-agreement",
] as const;

/** Waivers a parent must accept to register (shown in the registration flow, edited like any page). */
export const WAIVER_SLUGS = ["waiver-liability", "waiver-medical", "waiver-media"] as const;
export type PageSlug = (typeof PAGE_SLUGS)[number];

export const DEFAULT_PAGES: DefaultPage[] = [
  {
    slug: "about",
    title: "About the league",
    body: `The **North Florida Flag League (NFFL)** is youth flag football for boys and girls. We're built on four things: **football, fun, development and community.**

## Our mission

More than a league: we build players, leaders and a stronger North Florida. [ADD THE LEAGUE'S MISSION STATEMENT IN YOUR OWN WORDS.]

## Who can play

- **Boys:** 4U/5U, 6U, 7U, 8U, 9U, 10U, 11U and 12U
- **Girls:** 4U/5U, 6U, 7U, 8U, 9U, 10U, 11U, 12U and 14U

## The 2027 season

| | |
| --- | --- |
| Registration | December 1 – January 3 |
| Draft | January 4, 2027 |
| First practice | January 6, 2027 |
| Practices | Monday – Wednesday, 6:00 – 7:30 PM |
| Games | Tuesday, Thursday and Saturday, February 2 – March 27 |
| Championship weekend | April 3 – 4 |

## Where we play

[ADD FIELD NAMES AND ADDRESSES.]

## League leadership

[ADD COMMISSIONER / BOARD NAMES AND ROLES, OR REMOVE THIS SECTION.]`,
  },
  {
    slug: "rules",
    title: "Rules and policies",
    body: `These are the policies every family agrees to at registration. [REVIEW AND REPLACE WITH THE LEAGUE'S OFFICIAL RULES.]

## Game rules

- [NUMBER OF PLAYERS ON THE FIELD BY AGE GROUP]
- [FIELD SIZE, GAME LENGTH AND TIMEOUTS]
- [SCORING, RUSHING AND NO-RUN ZONES]
- [FLAG GUARDING, CONTACT AND PENALTIES]

## Age eligibility

Players are placed by age group. The league confirms each player's division and may ask for proof of age. [ADD THE AGE CUTOFF DATE.]

## Code of conduct

Players, parents, coaches and spectators are expected to show respect for players, coaches, officials and each other. [ADD SPECIFIC EXPECTATIONS AND CONSEQUENCES.]

## Weather and cancellations

Games or practices cancelled for weather are announced on this site and by email. [ADD MAKE-UP GAME POLICY.]

## Refunds

[ADD REFUND DEADLINES AND AMOUNTS.]

## Photos and video

Families choose at registration whether the league may use photos or video of their player. [CONFIRM WORDING WITH COUNSEL.]`,
  },
  {
    slug: "coaches",
    title: "Coaches and team staff",
    body: `Coaches and team moms make the season happen.

## Roles

- **Head Coach:** runs practices and games for one team.
- **Assistant Coach:** supports the head coach.
- **Team Mom:** handles team communication and logistics.

## Fees

| Role | Fee |
| --- | --- |
| Coaching badge | $25 |
| Team mom | $25 |

## Requirements

[ADD BACKGROUND SCREENING, TRAINING AND BADGE REQUIREMENTS.]

## How to apply

Apply online at [Coaches & Team Staff](/coaches-staff). The coaching badge or team mom fee is paid when you apply and refunded if you're not approved. Questions? Use the [contact form](/contact).`,
  },
  {
    slug: "faq",
    title: "Frequently asked questions",
    body: `## When is registration?

December 1 through January 3. Create your family account any time before then.

## How much does it cost?

Registration is **$100 per player**. Game-day gate fees are $7 for adults, $4 for kids, and free for children 4 and under.

## Can I register more than one child?

Yes. Add each child to your family account and pay for all of them in one checkout.

## Can I request a coach or a team?

You can note a request at registration. Teams are formed at the draft on January 4, so requests aren't guaranteed.

## When and where are practices and games?

Practices are Monday – Wednesday, 6:00 – 7:30 PM. Games are Tuesday, Thursday and Saturday from February 2 to March 27. [ADD LOCATIONS.]

## What equipment does my child need?

[ADD CLEATS, MOUTHGUARD AND OTHER REQUIREMENTS, AND WHAT THE LEAGUE PROVIDES.]

## What is the refund policy?

See [Rules and policies](/rules).

## How do I reach the league?

Use the [contact form](/contact).`,
  },
  {
    slug: "contact",
    title: "Contact us",
    body: `Questions about registration, teams or volunteering? Send us a message and we'll reply by email. [ADD EXPECTED RESPONSE TIME.]`,
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    body: `> **Draft — pending legal review.** This placeholder must be reviewed by the league's attorney before launch.

*Last updated: [DATE]*

This policy explains how the North Florida Flag League ("NFFL", "we") collects, uses and protects information on nfflag.com.

## Information we collect

- **Parent or guardian account:** name, email address, phone number, password (stored encrypted) and household details.
- **Player information you provide:** name, date of birth, division, jersey size, playing experience, emergency contacts, and health information you choose to share for your child's safety (such as allergies, medications and physician contact).
- **Proof of age** when the league requests it.
- **Payments** are processed by Stripe (or Square, our backup processor). We receive payment status and receipt details; we do not store card numbers.
- **Technical information** such as IP address and browser type, used for security.

## How we use it

To run registration, eligibility, teams, schedules and communication; to keep players safe; to process payments and refunds; and to protect accounts.

## Who can see it

- League administrators with a need to know.
- Your child's coaches see roster and emergency information needed to coach and keep players safe.
- Service providers acting for us: Stripe and Square (payments), Resend (email), Twilio (text messages), Google Cloud and Vercel (hosting).

We do not sell personal information.

## Children's information

Children do not have accounts. All player information is provided and managed by a parent or guardian.

## Security and retention

Information is encrypted in transit and at rest, and access is limited and logged. We keep records for [RETENTION PERIOD] unless the law requires otherwise.

## Your choices

You can update your household and player information from your account. To request access or deletion, [CONTACT INSTRUCTIONS].

## Contact

[LEAGUE LEGAL NAME, MAILING ADDRESS, EMAIL]`,
  },
  {
    slug: "terms",
    title: "Terms of use",
    body: `> **Draft — pending legal review.** This placeholder must be reviewed by the league's attorney before launch.

*Last updated: [DATE]*

By creating an account or registering a player on nfflag.com, you agree to these terms.

## Accounts

You must be at least 18 and the parent or legal guardian of any player you register. Keep your sign-in details private; you're responsible for activity on your account.

## Registration and payment

Registration is complete once payment is confirmed and the league confirms eligibility. Fees are listed on this site. Payments are processed by Stripe (or Square, our backup processor).

## Refunds

Refunds follow the policy in [Rules and policies](/rules).

## Conduct

Families, players, coaches and team staff agree to the league's code of conduct. The league may suspend accounts or participation for violations.

## Waivers

Participation requires the liability waiver and medical authorization accepted at registration.

## Changes

We may update these terms; the date above shows the latest version.

## Governing law

These terms are governed by the laws of the State of Florida.

## Contact

[LEAGUE LEGAL NAME, MAILING ADDRESS, EMAIL]`,
  },
];

const DRAFT_NOTICE =
  "> **Placeholder wording, pending review by the league's attorney (D-08).** Replace this text in Admin → Site content before registration opens.\n\n";

DEFAULT_PAGES.push(
  {
    slug: "waiver-liability",
    title: "Participation waiver and release",
    body:
      DRAFT_NOTICE +
      `I am the parent or legal guardian of the player named in this registration. I understand that flag football is a physical activity and that injuries can happen, including injuries from contact with other players, the ground or equipment.

I agree that my child may take part in [LEAGUE NAME] practices, games and events, and I accept the risks of participation. I release [LEAGUE NAME], its volunteers, coaches, officials and sponsors from claims arising from ordinary participation, to the extent allowed by Florida law.

I agree that my child will follow the league's rules and code of conduct.`,
  },
  {
    slug: "waiver-medical",
    title: "Medical authorization",
    body:
      DRAFT_NOTICE +
      `If my child is injured or becomes ill during a league activity and I cannot be reached, I authorize league coaches and officials to seek emergency medical treatment for my child.

I confirm that the medical and emergency-contact information I have provided is accurate, and I will update it if anything changes.`,
  },
  {
    slug: "waiver-media",
    title: "Photo and video release",
    body:
      DRAFT_NOTICE +
      `I agree that photos and video of my child taken at league activities may be used on the league's website, social media and printed materials. The league will not publish my child's full name together with their photo without my permission.

To opt out at any time, contact [LEAGUE EMAIL].`,
  },
);

DEFAULT_PAGES.push({
  slug: "volunteer-agreement",
  title: "Coach & staff code of conduct and screening consent",
  body:
    DRAFT_NOTICE +
    `As a [LEAGUE NAME] coach or team mom, I agree to put players' safety and enjoyment first, follow the league's rules and code of conduct, and treat players, families, officials and other volunteers with respect.

I consent to the background screening the league requires for coaches and team staff who work with children under Florida law, and I understand I can't be approved until it is complete and cleared.

I understand my coaching badge or team mom fee is refunded if my application isn't approved.`,
});

export interface Announcement {
  enabled: boolean;
  message: string;
  linkText?: string;
  linkHref?: string;
}

export interface ContactInfo {
  /** Where contact-form messages are sent. Not shown publicly unless showEmail. */
  inboxEmail: string;
  publicEmail?: string;
  phone?: string;
}

export const DEFAULT_SETTINGS: { announcement: Announcement; contact: ContactInfo; homepage: Homepage; seasonHome: SeasonHome; images: ImageSlots } = {
  homepage: DEFAULT_HOMEPAGE,
  seasonHome: DEFAULT_SEASON_HOME,
  images: DEFAULT_IMAGE_SLOTS,
  announcement: {
    enabled: true,
    message: "Registration for the 2027 season opens December 1.",
    linkText: "Create your family account",
    linkHref: "/sign-up",
  },
  contact: {
    inboxEmail: "",
    publicEmail: "",
    phone: "",
  },
};
