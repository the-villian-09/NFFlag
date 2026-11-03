/**
 * Forwards /api/* to the API on Cloud Run, adding:
 *   x-nffl-proxy      the shared secret (API_PROXY_SECRET), so the API can
 *                     refuse anything that didn't come through the website;
 *   x-nffl-client-ip  the visitor's IP as Vercel saw it, which the API uses
 *                     for rate limits, the audit log and consent records.
 * Any copies of those headers sent by the browser are dropped first.
 */
import { NextResponse, type NextRequest } from "next/server";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:8080";

function visitorIp(req: NextRequest) {
  // Vercel sets these at its edge; the first X-Forwarded-For entry is the visitor.
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.delete("x-nffl-proxy");
  headers.delete("x-nffl-client-ip");
  const secret = process.env.API_PROXY_SECRET;
  if (secret) headers.set("x-nffl-proxy", secret);
  const ip = visitorIp(req);
  if (ip) headers.set("x-nffl-client-ip", ip);
  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, API_ORIGIN);
  return NextResponse.rewrite(target, { request: { headers } });
}

export const config = { matcher: "/api/:path*" };
