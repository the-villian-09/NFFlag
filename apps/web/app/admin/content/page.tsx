"use client";

import { DEFAULT_HOMEPAGE } from "@nffl/shared";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { HomepageForm } from "@/components/homepage-form";
import { PhotosCard, SeasonHomeForm } from "@/components/season-home-form";
import type { Homepage, ImageSlots, SeasonHome } from "@nffl/shared";

interface PageRow {
  slug: string;
  title: string;
  isPlaceholder: boolean;
  custom: boolean;
  nav: "menu" | "footer" | "none";
  navLabel: string | null;
  published: boolean;
  updatedAt: string;
}

const WHERE: Record<PageRow["nav"], string> = { menu: "Menu", footer: "Footer", none: "Link only" };
/** Where built-in pages are linked (fixed in the site layout). */
const BUILT_IN_WHERE: Record<string, string> = { about: "Menu", contact: "Menu and footer" };
interface Announcement {
  enabled: boolean;
  message: string;
  linkText?: string;
  linkHref?: string;
}
interface Contact {
  inboxEmail: string;
  publicEmail?: string;
  phone?: string;
}
interface Message {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  topic: string | null;
  message: string;
  emailedAt: string | null;
  createdAt: string;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

/** Admin: site content — pages, announcement banner, contact details, messages. */
export default function AdminContentPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [pages, setPages] = useState<PageRow[] | null>(null);
  const [banner, setBanner] = useState<Announcement | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [homepage, setHomepage] = useState<Homepage | null>(null);
  const [seasonHome, setSeasonHome] = useState<SeasonHome | null>(null);
  const [images, setImages] = useState<ImageSlots | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    if (!me.permissions.includes("content.manage")) {
      router.replace("/admin");
      return;
    }
    Promise.all([
      api.get<{ items: PageRow[] }>("/admin/content/pages"),
      api.get<{ announcement: Announcement; contact: Contact; homepage: Homepage; seasonHome: SeasonHome; images: ImageSlots }>("/admin/content/settings"),
      api.get<{ items: Message[] }>("/admin/content/contact-messages"),
    ])
      .then(([p, s, m]) => {
        setPages(p.items);
        setBanner(s.announcement);
        setContact(s.contact);
        setHomepage(s.homepage);
        setSeasonHome(s.seasonHome);
        setImages(s.images);
        setMessages(m.items);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === "SESSION_IDLE") router.replace("/sign-in");
        else setLoadError(err instanceof Error ? err.message : "Couldn't load site content.");
      });
  }, [me, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Site content</h1>
      <p className="muted">Changes appear on the public site within about a minute. Every change is recorded in the audit log.</p>
      <ErrorAlert error={loadError} />

      <section className="card" style={{ marginTop: 24 }}>
        <div className="games-head">
          <h2 style={{ margin: 0 }}>Pages</h2>
          <Link className="btn small" href="/admin/content/new">
            + Add a page
          </Link>
        </div>
        {!pages ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-wrap">
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Shows in</th>
                  <th>Status</th>
                  <th>Last updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.slug}>
                    <td data-label="">
                      <strong>{p.title}</strong>
                      <br />
                      <code>{p.custom ? `/p/${p.slug}` : `/${p.slug}`}</code> <span className="muted">· {p.custom ? "added by you" : "built-in"}</span>
                    </td>
                    <td data-label="Shows in">{p.custom ? WHERE[p.nav] : (BUILT_IN_WHERE[p.slug] ?? "Footer")}</td>
                    <td data-label="Status">
                      {p.custom ? (
                        p.published ? <span className="status ok">Live</span> : <span className="status warn">Draft</span>
                      ) : p.isPlaceholder ? (
                        <span className="status warn">Placeholder</span>
                      ) : (
                        <span className="status ok">Edited</span>
                      )}
                    </td>
                    <td data-label="Updated">{fmt(p.updatedAt)}</td>
                    <td data-label="" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <Link className="btn small" href={`/admin/content/${p.slug}`}>
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>
          Built-in pages can be edited but not deleted. Pages you add can be hidden or deleted. Waivers and agreements are in{" "}
          <Link href="/admin/forms">Waivers &amp; forms</Link>.
        </p>
      </section>

      {homepage && <HomepageForm initial={{ ...DEFAULT_HOMEPAGE, ...homepage }} />}
      {seasonHome && <SeasonHomeForm initial={seasonHome} />}
      {images && <PhotosCard initial={images} />}

      <div className="grid" style={{ marginTop: 24 }}>
        {banner && <BannerForm initial={banner} />}
        {contact && <ContactSettingsForm initial={contact} />}
      </div>

      <section className="card" style={{ marginTop: 24 }}>
        <h2>Contact form messages</h2>
        {!messages ? (
          <p className="muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 16 }}>
            {messages.map((m) => (
              <article key={m.id} className="message">
                <header>
                  <strong>{m.name}</strong> · <a href={`mailto:${m.email}`}>{m.email}</a>
                  {m.phone ? ` · ${m.phone}` : ""}
                  <span className="muted">
                    {" "}
                    · {m.topic ?? "general"} · {fmt(m.createdAt)} · {m.emailedAt ? "emailed" : "not emailed"}
                  </span>
                </header>
                <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{m.message}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function BannerForm({ initial }: { initial: Announcement }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const body = {
      enabled: f.get("enabled") === "on",
      message: String(f.get("message") ?? ""),
      linkText: String(f.get("linkText") ?? ""),
      linkHref: String(f.get("linkHref") ?? ""),
    };
    if ((await run(() => api.put("/admin/content/settings/announcement", body))) !== undefined) setSaved(true);
  }
  return (
    <section className="card">
      <h2>Announcement banner</h2>
      <p className="muted" style={{ margin: 0 }}>The yellow bar across the top of every page. Use it for registration news or rainouts.</p>
      <form className="stack" onSubmit={onSubmit}>
        <ErrorAlert error={error} />
        {saved && <div className="alert ok" role="status">Saved.</div>}
        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={initial.enabled} /> Show the banner
        </label>
        <label>
          Message
          <input type="text" name="message" defaultValue={initial.message} maxLength={200} />
        </label>
        <div className="form-row">
          <label>
            Link text (optional)
            <input type="text" name="linkText" defaultValue={initial.linkText ?? ""} maxLength={60} />
          </label>
          <label>
            Link (optional)
            <input type="text" name="linkHref" defaultValue={initial.linkHref ?? ""} placeholder="/sign-up" maxLength={300} />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save banner"}
        </button>
      </form>
    </section>
  );
}

function ContactSettingsForm({ initial }: { initial: Contact }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const body = {
      inboxEmail: String(f.get("inboxEmail") ?? "").trim(),
      publicEmail: String(f.get("publicEmail") ?? "").trim(),
      phone: String(f.get("phone") ?? "").trim(),
    };
    if ((await run(() => api.put("/admin/content/settings/contact", body))) !== undefined) setSaved(true);
  }
  return (
    <section className="card">
      <h2>Contact details</h2>
      <form className="stack" onSubmit={onSubmit}>
        <ErrorAlert error={error} />
        {saved && <div className="alert ok" role="status">Saved.</div>}
        <label>
          Send contact-form messages to
          <input type="email" name="inboxEmail" defaultValue={initial.inboxEmail} placeholder="league inbox (not shown publicly)" />
        </label>
        <label>
          Public email (optional)
          <input type="email" name="publicEmail" defaultValue={initial.publicEmail ?? ""} />
        </label>
        <label>
          Public phone (optional)
          <input type="text" name="phone" defaultValue={initial.phone ?? ""} maxLength={32} />
        </label>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save contact details"}
        </button>
      </form>
    </section>
  );
}
