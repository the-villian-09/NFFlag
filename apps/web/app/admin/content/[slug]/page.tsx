"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { Markdown } from "@/components/markdown";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

type Nav = "menu" | "footer" | "none";
interface Page {
  slug: string;
  title: string;
  body: string;
  isPlaceholder: boolean;
  custom: boolean;
  nav: Nav;
  navLabel: string | null;
  published: boolean;
}

/** "Picture day!" → "picture-day" */
const toSlug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

/**
 * Edit a public page, or add one (/admin/content/new): Markdown on the left,
 * live preview on the right. Pages admins add also choose their address and
 * whether they're linked from the menu, the footer, or nowhere.
 */
export default function EditContentPage() {
  const { slug } = useParams<{ slug: string }>();
  const isNew = slug === "new";
  const router = useRouter();
  const { me, loading } = useMe();
  const [page, setPage] = useState<Page | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [address, setAddress] = useState("");
  const [addressTouched, setAddressTouched] = useState(false);
  const [nav, setNav] = useState<Nav>("footer");
  const [navLabel, setNavLabel] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    if (isNew) {
      setPage({ slug: "", title: "", body: "", isPlaceholder: false, custom: true, nav: "footer", navLabel: null, published: false });
      return;
    }
    api
      .get<{ page: Page }>(`/admin/content/pages/${slug}`)
      .then(({ page: p }) => {
        setPage(p);
        setTitle(p.title);
        setBody(p.body);
        setNav(p.nav);
        setNavLabel(p.navLabel ?? "");
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load this page.");
      });
  }, [me, slug, isNew, router, setError]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = () => {
    setDirty(true);
    setSaved(null);
  };

  async function save(publish: boolean) {
    if (!page) return;
    setSaved(null);
    const custom = { nav, navLabel: navLabel.trim() || null, published: publish };
    if (isNew) {
      const r = await run(() => api.post<{ page: Page }>("/admin/content/pages", { slug: address, title, body, ...custom }));
      if (r) {
        setDirty(false);
        router.replace(`/admin/content/${r.page.slug}`);
      }
      return;
    }
    const r = await run(() => api.put<{ page: Page }>(`/admin/content/pages/${slug}`, page.custom ? { title, body, ...custom } : { title, body }));
    if (r) {
      setPage(r.page);
      setDirty(false);
      setSaved(page.custom && !publish ? "Saved as a draft. It isn't on the site." : "Published. It will show on the site within about a minute.");
    }
  }

  async function remove() {
    if (!page || !window.confirm(`Delete “${page.title}”? Links to it will stop working. This can't be undone.`)) return;
    if ((await run(() => api.del(`/admin/content/pages/${slug}`))) !== undefined) router.replace("/admin/content");
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const custom = page?.custom ?? false;
  const path = custom ? `/p/${isNew ? address || "…" : slug}` : `/${slug}`;

  return (
    <main className="page" style={{ maxWidth: 1400 }}>
      <p>
        <Link href="/admin/content">← Site content</Link>
      </p>
      <h1>{isNew ? "Add a page" : "Edit page"}</h1>
      {!page ? (
        <>
          <ErrorAlert error={error} />
          <p className="muted">Loading…</p>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <div className="editor-bar">
            <label style={{ flex: "1 1 320px" }}>
              Page title
              <input
                type="text"
                value={title}
                maxLength={120}
                required
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (isNew && !addressTouched) setAddress(toSlug(e.target.value));
                  touch();
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              {!isNew && (custom ? page.published : true) && (
                <a className="btn ghost small" href={path} target="_blank" rel="noopener noreferrer">
                  View page
                </a>
              )}
              {custom && (
                <button type="button" className="btn ghost small" disabled={busy} onClick={() => save(false)}>
                  {page.published && !isNew ? "Unpublish (save as draft)" : "Save as draft"}
                </button>
              )}
              <button className="btn" disabled={busy || (!dirty && !(custom && !page.published))}>
                {busy ? "Saving…" : dirty || (custom && !page.published) ? "Save and publish" : "Saved"}
              </button>
            </div>
          </div>

          {custom && (
            <div className="page-settings">
              <label>
                Address
                <span className="address-field">
                  <span className="muted">nfflag.com/p/</span>
                  <input
                    type="text"
                    value={isNew ? address : slug}
                    disabled={!isNew}
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={60}
                    onChange={(e) => {
                      setAddress(toSlug(e.target.value) + (e.target.value.endsWith("-") ? "-" : ""));
                      setAddressTouched(true);
                      touch();
                    }}
                  />
                </span>
                <span className="muted editor-help">{isNew ? "Letters, numbers and dashes. It can't be changed later." : "The address can't be changed."}</span>
              </label>
              <fieldset>
                <legend>Where it shows</legend>
                {(
                  [
                    ["menu", "Main menu (top of every page)"],
                    ["footer", "Footer links"],
                    ["none", "Nowhere: link only (for emails or the banner)"],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="radio">
                    <input
                      type="radio"
                      name="nav"
                      checked={nav === v}
                      onChange={() => {
                        setNav(v);
                        touch();
                      }}
                    />{" "}
                    {label}
                  </label>
                ))}
              </fieldset>
              {nav !== "none" && (
                <label>
                  {nav === "menu" ? "Menu" : "Footer"} label (short)
                  <input
                    type="text"
                    value={navLabel}
                    maxLength={24}
                    placeholder={title.slice(0, 24)}
                    onChange={(e) => {
                      setNavLabel(e.target.value);
                      touch();
                    }}
                  />
                </label>
              )}
            </div>
          )}

          <ErrorAlert error={error} />
          {saved && (
            <div className="alert ok" role="status" style={{ marginTop: 12 }}>
              {saved}
            </div>
          )}
          <div className="editor">
            <label className="editor-source">
              Content
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  touch();
                }}
                spellCheck
              />
              <span className="muted editor-help">## Heading · **bold** · - bullet list · [link text](/faq) · | table | columns |</span>
            </label>
            <div className="editor-preview" aria-label="Preview">
              <span className="editor-preview-label">Preview · {path}</span>
              <h2 className="page-title" style={{ fontSize: 44 }}>
                {title}
              </h2>
              <Markdown source={body} />
            </div>
          </div>
          {custom && !isNew && (
            <p style={{ marginTop: 24 }}>
              <button type="button" className="btn danger small" disabled={busy} onClick={remove}>
                Delete this page
              </button>
            </p>
          )}
        </form>
      )}
    </main>
  );
}
