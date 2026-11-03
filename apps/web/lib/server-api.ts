/**
 * Server-side API calls (server components). Goes straight to the API origin;
 * returns null if the API is unreachable so pages degrade instead of crashing.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:8080";

export async function serverGet<T>(path: string, revalidateSeconds = 60): Promise<T | null> {
  try {
    const secret = process.env.API_PROXY_SECRET;
    const res = await fetch(`${API_ORIGIN}/api/v1${path}`, {
      next: { revalidate: revalidateSeconds },
      // Lets the API know this call came from the website (see proxy.ts).
      headers: secret ? { "x-nffl-proxy": secret } : undefined,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface SiteInfo {
  announcement: { message: string; linkText?: string; linkHref?: string } | null;
  contact: { publicEmail: string | null; phone: string | null };
}

export interface ContentPage {
  slug: string;
  title: string;
  body: string;
  isPlaceholder: boolean;
  updatedAt: string;
}

export const PAGES: { slug: string; label: string }[] = [
  { slug: "about", label: "About" },
  { slug: "rules", label: "Rules and policies" },
  { slug: "coaches", label: "Coaches and team staff" },
  { slug: "faq", label: "FAQ" },
  { slug: "contact", label: "Contact" },
  { slug: "privacy", label: "Privacy" },
  { slug: "terms", label: "Terms" },
  { slug: "text-alerts", label: "Text alerts" },
];
