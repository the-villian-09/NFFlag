import type { NextConfig } from "next";

/**
 * The browser only ever talks to this origin. /api/* is proxied to the API on
 * Cloud Run, so auth cookies are first-party and no CORS is needed.
 * API_ORIGIN: e.g. https://nffl-api-xxxxx-ue.a.run.app (set per Vercel environment).
 *   - main branch       → staging.nfflag.com → staging API
 *   - production branch → nfflag.com         → production API (branch-specific value)
 * Vercel skips builds for commits that don't touch apps/web, so a release that only
 * changes the API won't rebuild the site.
 */
const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:8080";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@nffl/shared"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async redirects() {
    return [
      // Earlier name of the coaches & team staff pages (links in already-sent emails).
      { source: "/volunteer", destination: "/coaches-staff", permanent: true },
      { source: "/admin/volunteers", destination: "/admin/staff", permanent: true },
      { source: "/admin/volunteers/:id", destination: "/admin/staff/:id", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
