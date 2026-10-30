import type { NextConfig } from "next";

/**
 * The browser only ever talks to this origin. /api/* is proxied to the API on
 * Cloud Run, so auth cookies are first-party and no CORS is needed.
 * API_ORIGIN: e.g. https://nffl-api-xxxxx-ue.a.run.app (set per Vercel environment).
 */
const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:8080";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@nffl/shared"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
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
