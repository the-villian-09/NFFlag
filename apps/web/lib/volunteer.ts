/** Labels for volunteer application and background-check statuses. */
export const APP_STATUS: Record<string, { label: string; tone: string }> = {
  pending_payment: { label: "Awaiting fee", tone: "warn" },
  processing: { label: "Confirming payment", tone: "info" },
  submitted: { label: "Needs review", tone: "info" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Not approved", tone: "bad" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};
export const SCREENING: Record<string, { label: string; tone: string }> = {
  not_started: { label: "Not started", tone: "muted" },
  pending: { label: "In progress", tone: "warn" },
  cleared: { label: "Cleared", tone: "ok" },
  not_cleared: { label: "Not cleared", tone: "bad" },
};
