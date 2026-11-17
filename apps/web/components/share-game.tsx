"use client";

/**
 * Share buttons for games and division schedules.
 *
 * On a phone, Share opens the phone's own share menu (every app the person
 * has: Messages, Facebook, Instagram, WhatsApp…). On a computer, it opens a
 * share window: the game image (square post or story), an editable message,
 * Facebook / X / WhatsApp / Text / Email, Copy link, and Download image.
 * The shared link is the game's own page, whose preview shows the game image.
 */
import { useState } from "react";
import { Modal } from "@/components/modal";
import { gamePath, imagePath, shareText, shareTitle } from "@/lib/game-share";
import type { Game } from "@/lib/schedule";

interface ShareTarget {
  /** Window title. */
  heading: string;
  /** Title for the share menu / email subject. */
  title: string;
  /** Message, editable in the window. */
  text: string;
  /** Path on this site, e.g. /games/<id>. */
  path: string;
  /** Game id when there's a game image to show and download. */
  gameId?: string;
}

const ShareIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" />
    <path d="M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);

/** A phone or tablet with its own share menu (touch screen + Web Share). */
const phoneShare = () =>
  typeof navigator !== "undefined" && typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches;

function useShare() {
  const [open, setOpen] = useState<ShareTarget | null>(null);
  async function share(t: ShareTarget) {
    if (phoneShare()) {
      try {
        await navigator.share({ title: t.title, text: t.text, url: `${window.location.origin}${t.path}` });
        return;
      } catch (err) {
        // Closed the menu: done. Anything else: fall back to our window.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    setOpen(t);
  }
  const dialog = open ? <ShareWindow target={open} onClose={() => setOpen(null)} /> : null;
  return { share, dialog };
}

function ShareWindow({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [message, setMessage] = useState(target.text);
  const [shape, setShape] = useState<"square" | "story">("square");
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${target.path}`;
  const enc = encodeURIComponent;
  const withLink = `${message} ${url}`;
  const links = [
    { name: "Facebook", short: "f", tone: "fb", href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
    { name: "X", short: "X", tone: "x", href: `https://x.com/intent/post?text=${enc(message)}&url=${enc(url)}` },
    { name: "WhatsApp", short: "Wa", tone: "wa", href: `https://wa.me/?text=${enc(withLink)}` },
    { name: "Text", short: "Tx", tone: "tx", href: `sms:?&body=${enc(withLink)}` },
    { name: "Email", short: "@", tone: "em", href: `mailto:?subject=${enc(target.title)}&body=${enc(`${message}\n\n${url}`)}` },
  ];
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }
  return (
    <Modal open title={target.heading} onClose={onClose}>
      <div className={`share-window${target.gameId ? "" : " no-image"}`}>
        {target.gameId && (
          <div className="share-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imagePath(target.gameId, shape)} alt={`${target.title} image`} className={shape} />
            <div className="share-shape" role="group" aria-label="Image shape">
              <button type="button" className={shape === "square" ? "on" : ""} aria-pressed={shape === "square"} onClick={() => setShape("square")}>
                Square post
              </button>
              <button type="button" className={shape === "story" ? "on" : ""} aria-pressed={shape === "story"} onClick={() => setShape("story")}>
                Story
              </button>
            </div>
          </div>
        )}
        <div className="share-main">
          <label className="share-message">
            Message (you can change it)
            <textarea rows={3} value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="share-targets">
            {links.map((l) => (
              <a key={l.name} href={l.href} target="_blank" rel="noopener noreferrer" className="share-target">
                <span className={`share-badge ${l.tone}`} aria-hidden="true">
                  {l.short}
                </span>
                {l.name}
              </a>
            ))}
            {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
              <button type="button" className="share-target" onClick={() => navigator.share({ title: target.title, text: message, url }).catch(() => {})}>
                <span className="share-badge more" aria-hidden="true">
                  …
                </span>
                More apps
              </button>
            )}
          </div>
          <div className="share-link">
            <input readOnly value={url} aria-label="Link" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn small" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <span className="sr-only" role="status">
            {copied ? "Link copied" : ""}
          </span>
          {target.gameId && (
            <>
              <a className="btn ghost small share-download" href={imagePath(target.gameId, shape, true)} download>
                Download {shape === "story" ? "story" : "post"} image
              </a>
              <p className="muted share-note">Instagram doesn&apos;t take links from websites: download the image and post it from the Instagram app.</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Share one game. "button": labelled ghost button; "icon": square icon button (lists). */
export function ShareGameButton({ game, division, variant = "button" }: { game: Game; division: string; variant?: "button" | "icon" }) {
  const { share, dialog } = useShare();
  const target: ShareTarget = {
    heading: game.status === "final" ? "Share this result" : "Share this game",
    title: shareTitle(game),
    text: shareText(game, division),
    path: gamePath(game.id),
    gameId: game.id,
  };
  const label = `Share ${game.home} vs ${game.away}`;
  return (
    <>
      {variant === "icon" ? (
        <button type="button" className="share-icon-btn" aria-label={label} title="Share" onClick={() => share(target)}>
          <ShareIcon size={20} />
        </button>
      ) : (
        <button type="button" className="btn ghost small share-btn" aria-label={label} onClick={() => share(target)}>
          <ShareIcon />
          <span className="lbl">Share game</span>
        </button>
      )}
      {dialog}
    </>
  );
}

/** Share a division's whole schedule (links to the schedule page, searched to that division). */
export function ShareScheduleButton({ division, season }: { division: string; season: string }) {
  const { share, dialog } = useShare();
  return (
    <>
      <button
        type="button"
        className="btn ghost small share-btn"
        onClick={() =>
          share({
            heading: "Share the schedule",
            title: `${division} schedule · ${season}`,
            text: `Here's the ${division} game schedule for ${season}.`,
            path: `/schedule?q=${encodeURIComponent(division)}`,
          })
        }
      >
        <ShareIcon />
        Share schedule
      </button>
      {dialog}
    </>
  );
}
