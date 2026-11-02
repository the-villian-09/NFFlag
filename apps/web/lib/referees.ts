/** Labels and types shared by the referee pages. */
export const REF_STATUS: Record<string, { label: string; tone: string }> = {
  submitted: { label: "Under review", tone: "info" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Not approved", tone: "bad" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
  revoked: { label: "Approval removed", tone: "bad" },
};

export const PAYOUT_SETUP: Record<string, { label: string; tone: string }> = {
  not_started: { label: "Not set up", tone: "muted" },
  needs_info: { label: "Needs info", tone: "warn" },
  in_review: { label: "Stripe reviewing", tone: "info" },
  ready: { label: "Ready to be paid", tone: "ok" },
};

export const OFFICIAL_STATUS: Record<string, { label: string; tone: string }> = {
  assigned: { label: "On this game", tone: "info" },
  worked: { label: "Worked", tone: "ok" },
  no_show: { label: "No-show", tone: "bad" },
};

export const PAYOUT_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting", tone: "warn" },
  paid: { label: "Paid", tone: "ok" },
  failed: { label: "Not sent", tone: "bad" },
  void: { label: "Voided", tone: "muted" },
};

export const matchup = (g: { home: string | null; away: string | null }) => `${g.home ?? "TBD"} vs ${g.away ?? "TBD"}`;
