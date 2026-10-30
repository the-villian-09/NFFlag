import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContactForm } from "@/components/contact-form";
import { Markdown } from "@/components/markdown";
import { PAGES, serverGet, type ContentPage, type SiteInfo } from "@/lib/server-api";

/** Admin-edited pages. Edits show up within about a minute. */
export const revalidate = 60;
export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ slug: p.slug }));
}

async function getPage(slug: string) {
  const data = await serverGet<{ page: ContentPage }>(`/pages/${slug}`);
  return data?.page ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPage(slug);
  return { title: page?.title ?? PAGES.find((p) => p.slug === slug)?.label };
}

export default async function ContentPageView({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!PAGES.some((p) => p.slug === slug)) notFound();
  const page = await getPage(slug);
  const site = slug === "contact" ? await serverGet<SiteInfo>("/site") : null;

  return (
    <main className="page content-page">
      <h1 className="page-title">{page?.title ?? PAGES.find((p) => p.slug === slug)?.label}</h1>
      <div className="rule" />
      {page?.isPlaceholder && (
        <p className="placeholder-note">Placeholder text: the league is finalizing this page.</p>
      )}
      {page ? <Markdown source={page.body} /> : <p className="muted">This page is temporarily unavailable. Please try again shortly.</p>}

      {slug === "contact" && (
        <div className="contact-grid">
          <section className="card" aria-labelledby="contact-form-title">
            <h2 id="contact-form-title">Send a message</h2>
            <ContactForm />
          </section>
          {(site?.contact.publicEmail || site?.contact.phone) && (
            <aside className="card" aria-label="Contact details">
              <h2>Reach us</h2>
              {site.contact.publicEmail && (
                <p>
                  <a href={`mailto:${site.contact.publicEmail}`}>{site.contact.publicEmail}</a>
                </p>
              )}
              {site.contact.phone && (
                <p>
                  <a href={`tel:${site.contact.phone.replace(/[^\d+]/g, "")}`}>{site.contact.phone}</a>
                </p>
              )}
            </aside>
          )}
        </div>
      )}
    </main>
  );
}
