/** The admin portal's sections and pages, shared by the portal home and the side menu. */
export interface AdminItem {
  label: string;
  href: string;
  /** One short line on the portal tile. */
  blurb: string;
  /** Permission needed to see it. */
  perm: string;
  /** "Needs attention" keys whose counts show as this item's badge. */
  badges?: string[];
  /** Release switch it depends on (an "Off" chip shows while it's off). */
  flag?: string;
  /** Extra words people might search for. */
  keywords?: string;
}

export const ADMIN_GROUPS: { title: string; items: AdminItem[] }[] = [
  {
    title: "Families",
    items: [
      { label: "Registrations", href: "/admin/registrations", blurb: "Review, approve, refund, export", perm: "registrations.read", badges: ["registrations", "withdrawals"], keywords: "players refunds withdrawals eligibility spreadsheet" },
      { label: "Waitlist", href: "/admin/waitlist", blurb: "Full divisions and open offers", perm: "registrations.read", flag: "r2.waitlist_offers", keywords: "full offers" },
      { label: "Promo codes", href: "/admin/promo-codes", blurb: "Discounts for registration and staff fees", perm: "promo.manage", flag: "r2.promo_codes", keywords: "discount coupon" },
      { label: "Announcements", href: "/admin/announcements", blurb: "Email the league, a division or a team", perm: "announcements.send", flag: "r4.announcements", keywords: "email message" },
    ],
  },
  {
    title: "Teams & games",
    items: [
      { label: "Teams & draft", href: "/admin/teams", blurb: "Teams, coaches, draft board, rosters", perm: "teams.manage", flag: "r3.teams_draft", keywords: "roster draft board" },
      { label: "Schedule & scores", href: "/admin/schedule", blurb: "Games, imports, final scores, standings", perm: "games.manage", flag: "r4.games", keywords: "games scores standings tickets import" },
    ],
  },
  {
    title: "People",
    items: [
      { label: "Coaches & staff", href: "/admin/staff", blurb: "Applications and background checks", perm: "staff.applications.review", badges: ["staff"], keywords: "coach team mom background check" },
      { label: "Referees", href: "/admin/referees", blurb: "Sign-ups, assignments and approvals", perm: "referees.manage", badges: ["referees", "games_refs"], flag: "r5.referees", keywords: "officials refs assign" },
      { label: "Admins", href: "/admin/admins", blurb: "Who helps run the league", perm: "platform.admins.manage", keywords: "access super admin" },
    ],
  },
  {
    title: "Money",
    items: [
      { label: "Payments", href: "/admin/payments", blurb: "Stripe, Square backup, card fee", perm: "payments.read", badges: ["payments_down"], keywords: "stripe square card fee provider checkout" },
      { label: "Pay referees", href: "/admin/referees/pay", blurb: "Approve pay for final games", perm: "referees.pay", badges: ["ref_pay", "ref_pay_failed"], keywords: "payouts transfers 1099 add funds" },
    ],
  },
  {
    title: "Site & settings",
    items: [
      { label: "Site content", href: "/admin/content", blurb: "Pages, alert banner, contact messages", perm: "content.manage", keywords: "home page banner rainout faq contact messages" },
      { label: "Seasons & divisions", href: "/admin/seasons", blurb: "Dates, divisions, prices, referee rates", perm: "seasons.read", keywords: "season division price capacity age" },
      { label: "Release switches", href: "/admin/switches", blurb: "Turn features on when they're ready", perm: "platform.flags.manage", keywords: "flags features turn on" },
      { label: "Audit log", href: "/admin/audit", blurb: "Who changed what, and when", perm: "platform.audit.read", keywords: "history changes log" },
    ],
  },
];

export interface AttentionItem {
  key: string;
  count: number;
  cents?: number;
  label: string;
  href: string;
  tone: "warn" | "bad";
}

const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** The figure shown on a "Needs attention" item or badge. */
export const attentionFigure = (a: AttentionItem) => (a.cents !== undefined ? money(a.cents) : a.key === "payments_down" ? "!" : String(a.count));

/** An item's badge: its first attention entry ("bad" ones win). */
export function badgeFor(item: AdminItem, attention: AttentionItem[]) {
  const mine = attention.filter((a) => item.badges?.includes(a.key));
  const pick = mine.find((a) => a.tone === "bad") ?? mine[0];
  return pick ? { text: attentionFigure(pick), tone: pick.tone } : null;
}

export const visibleGroups = (perms: string[]) =>
  ADMIN_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => perms.includes(i.perm)) })).filter((g) => g.items.length > 0);
