/**
 * A path on this site. "//other.com" and "/\other.com" start with "/" but
 * browsers treat them as other sites, so they don't count.
 */
export const isSitePath = (v: string) => /^\/(?![/\\])/.test(v);

/** Only the site's own pictures: built-in images and uploaded photos. */
export const isSiteImage = (v: string) => /^\/(?:images\/[\w./-]+|api\/v1\/site-images\/[0-9a-f-]{36})$/i.test(v);
