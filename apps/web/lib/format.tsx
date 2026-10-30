/** Display helpers shared by family and admin screens. */

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.length === 10 ? `${iso}T12:00:00` : iso}`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : "—";

export const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
    : "—";

/** Registration status → label and badge style. */
export const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "info" | "bad" | "muted" }> = {
  pending_payment: { label: "Awaiting payment", tone: "warn" },
  processing: { label: "Confirming payment", tone: "info" },
  paid: { label: "Paid — in review", tone: "info" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Not accepted", tone: "bad" },
  expired: { label: "Hold expired", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "muted" as const };
  return <span className={`status ${s.tone}`}>{s.label}</span>;
}

export const GENDER_POLICY: Record<string, string> = { coed: "Co-ed", boys: "Boys", girls: "Girls" };
