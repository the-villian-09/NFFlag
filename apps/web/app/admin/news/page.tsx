"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { Modal } from "@/components/modal";
import { api, ApiError } from "@/lib/api";
import { uploadPhoto } from "@/lib/upload-photo";
import { useMe } from "@/lib/use-me";

interface Post {
  id: string;
  title: string;
  body: string;
  imageId: string | null;
  imageUrl: string | null;
  linkText: string | null;
  linkUrl: string | null;
  pinned: boolean;
  publishedAt: string;
}

const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
/** <input type="datetime-local"> works in the browser's time; the API stores UTC. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : "");

/** Admin: league news for the in-season home page and the News page. */
export default function AdminNewsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [items, setItems] = useState<Post[] | null>(null);
  const [editing, setEditing] = useState<Post | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: Post[] }>("/admin/content/news")
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load news.");
      });
  }, [router]);

  useEffect(() => {
    if (!me) return;
    if (!me.permissions.includes("content.manage")) return void router.replace("/admin");
    load();
  }, [me, router, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const now = Date.now();

  return (
    <main className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>League news</h1>
        <button className="btn" onClick={() => setEditing("new")}>
          New post
        </button>
      </div>
      <p className="muted">
        The latest three posts show on the in-season home page; all posts are on the <a href="/news">News page</a>. Pinned posts stay on top. Set a future date to post later.
      </p>
      <ErrorAlert error={error} />
      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <section className="card">
          <p className="muted" style={{ margin: 0 }}>
            No posts yet. Picture day, playoff formats, rainout make-up dates and game-day photos all work well here.
          </p>
        </section>
      ) : (
        <div className="admin-news">
          {items.map((n) => (
            <article key={n.id} className="admin-news-row">
              {n.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={n.imageUrl} alt="" />
              ) : (
                <span className="admin-news-noimg">No photo</span>
              )}
              <div>
                <strong>{n.title}</strong>
                <span className="muted">
                  {new Date(n.publishedAt).getTime() > now ? `Posts ${fmt(n.publishedAt)}` : `Posted ${fmt(n.publishedAt)}`}
                  {n.pinned ? " · " : ""}
                  {n.pinned && <span className="status info">Pinned</span>}
                  {new Date(n.publishedAt).getTime() > now && (
                    <>
                      {" "}
                      <span className="status warn">Scheduled</span>
                    </>
                  )}
                </span>
                {n.body && <span className="admin-news-body">{n.body}</span>}
              </div>
              <button className="btn small ghost" onClick={() => setEditing(n)}>
                Edit
              </button>
            </article>
          ))}
        </div>
      )}
      <Modal open={!!editing} title={editing === "new" ? "New post" : "Edit post"} onClose={() => setEditing(null)}>
        {editing && (
          <PostForm
            key={editing === "new" ? "new" : editing.id}
            post={editing === "new" ? null : editing}
            onDone={() => {
              setEditing(null);
              load();
            }}
          />
        )}
      </Modal>
    </main>
  );
}

function PostForm({ post, onDone }: { post: Post | null; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [image, setImage] = useState<{ id: string; url: string } | null>(post?.imageId && post.imageUrl ? { id: post.imageId, url: post.imageUrl } : null);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileId = useId();

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setUploading(true);
    setPhotoError(null);
    try {
      const img = await uploadPhoto("POST", "/admin/content/images?use=news", f, 1800);
      setImage({ id: img.id, url: img.url });
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "The upload didn't work.");
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    const body = {
      title: s("title"),
      body: s("body"),
      imageId: image?.id ?? null,
      linkText: s("linkText"),
      linkUrl: s("linkUrl").trim(),
      pinned: f.get("pinned") === "on",
      publishedAt: fromLocalInput(s("publishedAt")),
    };
    const r = await run(() => (post ? api.put(`/admin/content/news/${post.id}`, body) : api.post("/admin/content/news", body)));
    if (r !== undefined) onDone();
  }

  async function remove() {
    if (!post) return;
    if ((await run(() => api.del(`/admin/content/news/${post.id}`))) !== undefined) onDone();
  }

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorAlert error={error} />
      <label>
        Title
        <input type="text" name="title" required maxLength={120} defaultValue={post?.title ?? ""} placeholder="Picture day is next Saturday" />
      </label>
      <label>
        Post
        <textarea name="body" rows={6} maxLength={4000} defaultValue={post?.body ?? ""} />
        <span className="hint">Plain text. Leave a blank line between paragraphs. The home page shows the first paragraph.</span>
      </label>
      <div className="stack" style={{ gap: 8 }}>
        <span style={{ fontWeight: 700 }}>Photo (optional)</span>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt="" style={{ maxWidth: "100%", maxHeight: 220, objectFit: "cover" }} />
        )}
        <ErrorAlert error={photoError} />
        <span className="doc-actions">
          <input id={fileId} type="file" className="sr-only" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" disabled={uploading} onChange={pick} />
          <label htmlFor={fileId} className="btn small ghost" aria-disabled={uploading}>
            {uploading ? "Uploading…" : image ? "Replace photo" : "Add photo"}
          </label>
          {image && (
            <button type="button" className="link-btn" onClick={() => setImage(null)}>
              Remove photo
            </button>
          )}
        </span>
      </div>
      <div className="form-row">
        <label>
          Button text (optional)
          <input type="text" name="linkText" maxLength={40} defaultValue={post?.linkText ?? ""} placeholder="Read more" />
        </label>
        <label>
          Button link (optional)
          <input type="text" name="linkUrl" maxLength={500} defaultValue={post?.linkUrl ?? ""} placeholder="/schedule or https://…" />
        </label>
      </div>
      <div className="form-row">
        <label>
          Post date
          <input type="datetime-local" name="publishedAt" defaultValue={toLocalInput(post?.publishedAt ?? null)} />
          <span className="hint">Leave blank to post now. A future date keeps it hidden until then.</span>
        </label>
        <label className="check" style={{ alignSelf: "center" }}>
          <input type="checkbox" name="pinned" defaultChecked={post?.pinned ?? false} /> Pin to the top
        </label>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" disabled={busy || uploading}>
          {busy ? "Saving…" : post ? "Save post" : "Post"}
        </button>
        {post &&
          (confirmDelete ? (
            <>
              <span>Delete this post?</span>
              <button type="button" className="btn danger small" disabled={busy} onClick={remove}>
                Yes, delete
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="link-btn" onClick={() => setConfirmDelete(true)}>
              Delete post
            </button>
          ))}
      </div>
    </form>
  );
}
