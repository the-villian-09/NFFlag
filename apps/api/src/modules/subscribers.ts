/**
 * One place where modules attach outbox subscribers. Later releases add
 * lines here (e.g. registration.paid → receipt email, game.rescheduled → SMS)
 * without touching the code that publishes the event.
 */
import { logger } from "../lib/logger.js";
import { subscribe } from "./platform/outbox.js";

export function registerSubscribers() {
  subscribe("user.mfa_reset", async (e) => {
    logger.info({ userId: e.aggregateId }, "mfa reset recorded");
  });
}
