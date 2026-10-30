"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { Markdown } from "@/components/markdown";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

interface Page {
  slug: string;
  title: string;
  body: string;
  isPlaceholder: boolean;
}

/** Edit one public page: Markdown on the left, live preview on the right. */
export default function EditContentPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api
      .get<{ page: Page }>(`/admin/content/pages/${slug}`)
      .then(({ page }) => {
        setTitle(page.title);
        setBody(page.body);
        setLoaded(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load this page.");
      });
  }, [me, slug, router, setError]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if ((await run(() => api.put(`/admin/content/pages/${slug}`, { title, body }))) !== undefined) {
      setDirty(false);
      setSaved(true);
    }
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page" style={{ maxWidth: 1400 }}>
      <p>
        <Link href="/admin/content">← Site content</Link>
      </p>
      <h1>Edit page</h1>
      {!loaded ? (
        <>
          <ErrorAlert error={error} />
          <p className="muted">Loading…</p>
        </>
      ) : (
        <form onSubmit={save}>
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
                  setDirty(true);
                  setSaved(false);
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <a className="btn ghost small" href={`/${slug}`} target="_blank" rel="noopener noreferrer">
                View page
              </a>
              <button className="btn" disabled={busy || !dirty}>
                {busy ? "Saving…" : dirty ? "Save and publish" : "Saved"}
              </button>
            </div>
          </div>
          <ErrorAlert error={error} />
          {saved && (
            <div className="alert ok" role="status" style={{ marginTop: 12 }}>
              Published. It will show on the site within about a minute.
            </div>
          )}
          <div className="editor">
            <label className="editor-source">
              Content
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                  setSaved(false);
                }}
                spellCheck
              />
              <span className="muted editor-help">
                ## Heading · **bold** · - bullet list · [link text](/faq) · | table | columns |
              </span>
            </label>
            <div className="editor-preview" aria-label="Preview">
              <span className="editor-preview-label">Preview</span>
              <h2 className="page-title" style={{ fontSize: 44 }}>
                {title}
              </h2>
              <Markdown source={body} />
            </div>
          </div>
        </form>
      )}
    </main>
  );
}
