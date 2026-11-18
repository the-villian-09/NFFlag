import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { serverGet, type ContentPage } from "@/lib/server-api";

/** Pages the league added in the admin portal (Site content → Add a page). */
export const revalidate = 60;

const getPage = async (slug: string) =>
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? ((await serverGet<{ page: ContentPage }>(`/pages/${slug}`))?.page ?? null) : null;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = await getPage((await params).slug);
  return { title: page?.title ?? "Page not found" };
}

export default async function CustomPage({ params }: { params: Promise<{ slug: string }> }) {
  const page = await getPage((await params).slug);
  if (!page) notFound();
  return (
    <main className="page content-page">
      <h1 className="page-title">{page.title}</h1>
      <div className="rule" />
      <Markdown source={page.body} />
    </main>
  );
}
