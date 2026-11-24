/**
 * The NFFL Coaches Honor: the public page (/coaches-honor) and the wording
 * coaches and staff sign in the Waivers & forms library (seeded once; after
 * that admins edit the signed wording in Admin › Waivers & forms).
 */

export const COACHES_HONOR = {
  title: "The Coaches Honor",
  formTitle: "NFFL Coaches Honor & Player Safety Policy",
  eyebrow: "NFFL Player Safety Policy & Coaching Standards",
  intro:
    "Before a coach runs a single practice, they read the NFFL Player Safety Policy and sign the Coaches Honor. It's how every family knows exactly what to expect from the adults on the sideline.",
  rules: [
    {
      key: "two-adults",
      title: "Two adults, always",
      body: "At least two background-checked adults at every practice, game and team event. No coach is ever alone with a player, and no coach drives a player by themselves.",
    },
    {
      key: "report",
      title: "Call the state first",
      body: "Any sign of abuse or neglect is reported to the Florida Abuse Hotline (1-800-96-ABUSE) or 911 first, then to the NFFL. A coach who is reported is removed from contact with players while it's reviewed.",
    },
    {
      key: "parents",
      title: "Parents stay in the loop",
      body: "Coaches reach players only through NFFL team messages or group chats that include a parent. No private texts, DMs or social media messages to players.",
    },
    {
      key: "substance-free",
      title: "Drug & alcohol free",
      body: "No alcohol, tobacco, vaping, marijuana or illegal drugs at any NFFL practice, game, team party or event. No exceptions.",
    },
  ],
  pledgeTitle: "My pledge as an NFFL coach",
  pledge: [
    "I know I'm doing more than teaching flag football. The time my players spend with me shapes their confidence, their discipline, how they work with others and the friendships they make.",
    "My players won't remember every score or every play. They will remember how I treated them. My job is to send every one of them home a better athlete and a better person than when they arrived.",
  ],
  promises: [
    "Put every player's safety ahead of winning",
    "Teach the fundamentals the right way, at a pace that fits each age",
    "Expect real effort and hold everyone accountable, starting with me",
    "Encourage more than I correct, and celebrate progress, not just wins",
    "Respect the game, the officials, every family and our community",
    "Treat the trust parents give me as the responsibility it is",
  ],
  standards: [
    {
      title: "Lead by example",
      body: "Players copy what they see. Show up on time, dressed for practice, with the attitude and language you'd want from them. No yelling at kids, refs or parents, and no profanity at any NFFL event.",
    },
    {
      title: "Teach the game right",
      body: "Focus on fundamentals: flag pulling, routes, catching, ball security and the rules. Plan practices that fit the age group, keep everyone moving, and give every player real reps, not just your best few.",
    },
    {
      title: "Safety comes first",
      body: "Water breaks in Florida heat, practice stops for lightning, and any player with a possible head injury sits out and doesn't return that day without clearance from a medical professional. Tell a parent about every injury, however small.",
    },
    {
      title: "On game day",
      body: "Only the head coach speaks to officials, and always calmly. Keep your sideline under control, including your own parents. Accept calls you disagree with and raise concerns with the league afterward, not on the field.",
    },
    {
      title: "Away from the field",
      body: "You represent the NFFL in public and online. No one-on-one meetups, rides or private messages with players. Don't post photos of players without their parents' OK, and never share a player's personal information.",
    },
    {
      title: "Drug, alcohol & tobacco free",
      body: "Never use or be under the influence of alcohol, marijuana or illegal drugs at any NFFL activity, and no tobacco or vaping around players. Breaking this rule means removal from coaching.",
    },
    {
      title: "Respect players & families",
      body: "Every player is treated with dignity, whatever their skill. No insults, no singling kids out, no physical punishment and no hazing. Listen to parents and keep family matters private.",
    },
    {
      title: "Sportsmanship",
      body: "Shake hands win or lose. Don't run up the score or celebrate at the other team's expense. Teach players to help an opponent up and to thank the officials.",
    },
    {
      title: "Accountability",
      body: "Follow the NFFL Player Safety Policy and report concerns right away. Coaches who break these standards may be warned, suspended or removed, at the league's decision, to keep players safe.",
    },
  ],
} as const;

/** The wording coaches sign (Markdown), built from the same text as the page. */
export function coachesHonorMarkdown() {
  const c = COACHES_HONOR;
  return [
    "## The four rules",
    ...c.rules.map((r) => `- **${r.title}.** ${r.body}`),
    "",
    `## ${c.pledgeTitle}`,
    ...c.pledge.flatMap((p) => [p, ""]),
    "**So I promise to:**",
    "",
    ...c.promises.map((p) => `- ${p}`),
    "",
    "## The nine standards",
    ...c.standards.flatMap((s, i) => [`**${i + 1}. ${s.title}.** ${s.body}`, ""]),
    "Full page: [nfflag.com/coaches-honor](/coaches-honor)",
  ].join("\n");
}
