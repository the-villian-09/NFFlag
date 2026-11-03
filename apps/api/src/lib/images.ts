/**
 * Photo processing limits. Decoding a photo takes width × height × 4 bytes of
 * memory, so pixel counts are capped (the browser already shrinks photos to
 * 2,400 px before upload) and photos are processed one at a time per server,
 * so a few large uploads at once can't run the API out of memory.
 */
import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);

/** About 40 megapixels: any normal phone photo, but not a decompression bomb. */
export const MAX_INPUT_PIXELS = 40_000_000;

let queue: Promise<unknown> = Promise.resolve();

/** Runs image work one job at a time. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
