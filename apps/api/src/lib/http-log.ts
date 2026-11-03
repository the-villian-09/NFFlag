/**
 * What the request log may record: method, path and status only. Query
 * strings (sign-in codes, OAuth codes, search terms), request and response
 * headers (cookies, Set-Cookie, redirect links) are never logged, and tokens
 * that live in the path (password-reset links) are masked.
 */
const TOKEN_IN_PATH = /(\/(?:reset-password|verify-email|magic-link|callback)\/)[^/?#]+/gi;

export function safePath(url: string | undefined): string {
  if (!url) return "";
  const path = url.split(/[?#]/, 1)[0] ?? "";
  return path.replace(TOKEN_IN_PATH, "$1[redacted]");
}

export const httpLogSerializers = {
  req: (r: { id?: unknown; method?: string; url?: string }) => ({ id: r.id, method: r.method, url: safePath(r.url) }),
  res: (r: { statusCode?: number }) => ({ statusCode: r.statusCode }),
};
