import { canBuyTickets, type Game } from "@/lib/schedule";

/** "Buy tickets" for a game, opening the ticket site in a new tab. */
export function TicketButton({ g }: { g: Game }) {
  if (!canBuyTickets(g)) return null;
  return (
    <a className="btn small" href={g.ticketUrl!} target="_blank" rel="noopener noreferrer" aria-label={`Buy tickets: ${g.home} vs ${g.away}`}>
      Buy tickets
    </a>
  );
}
