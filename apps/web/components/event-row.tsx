import type { ReactNode } from "react";

const TZ = "America/New_York";

/** Weekday, day and month in league time, for the date tile. */
function dateParts(iso: string) {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: TZ });
  return {
    dow: part({ weekday: "short" }).toUpperCase(),
    day: part({ day: "numeric" }),
    mon: part({ month: "short" }).toUpperCase(),
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ }),
  };
}

/**
 * A game or practice: yellow date tile, start time in lime, then the title and
 * details. On phones the tile becomes a full-width date bar (date left, time
 * right). Used on the public schedule, the coach's team page and the family's
 * Schedule card.
 */
export function EventRow({
  startsAt,
  title,
  detail,
  badge,
  struck,
  extra,
  action,
}: {
  startsAt: string;
  title: ReactNode;
  detail?: ReactNode;
  badge?: ReactNode;
  struck?: boolean;
  extra?: ReactNode;
  /** A button on the right (e.g. Buy tickets); drops below the details on narrow screens. */
  action?: ReactNode;
}) {
  const p = dateParts(startsAt);
  return (
    <li className="ev">
      <span className="ev-bar">
        <span className="ev-bar-date">
          {p.dow}, {p.mon} {p.day}
        </span>
        <span className="ev-bar-time">
          {p.time}
          {badge}
        </span>
      </span>
      <time className="ev-tile" dateTime={startsAt} aria-label={`${p.dow} ${p.mon} ${p.day}`}>
        <span className="ev-dow">{p.dow}</span>
        <span className="ev-mon">{p.mon}</span>
        <span className="ev-day">{p.day}</span>
      </time>
      <span className="ev-body">
        <span className="ev-time">
          {p.time}
          {badge}
        </span>
        <span className="ev-title" style={struck ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
          {title}
        </span>
        {detail && <span className="ev-detail">{detail}</span>}
        {extra}
      </span>
      {action && <span className="ev-action">{action}</span>}
    </li>
  );
}
