import type { MetadataRoute } from "next";

/** Lets families add NFFL to their Home Screen (needed for iPhone notifications). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NFFL Flag Football",
    short_name: "NFFL",
    description: "Team updates, chat and schedules for NFFL families and coaches.",
    start_url: "/team",
    scope: "/",
    display: "standalone",
    background_color: "#011322",
    theme_color: "#011322",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
