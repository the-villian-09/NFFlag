/**
 * Branded HTML email with a matching plain-text version.
 *
 * Built for email clients, not browsers: tables for layout, inline styles,
 * no external CSS or fonts, and "bulletproof" buttons (a padded link inside a
 * table cell) that work in Outlook as well as Gmail and Apple Mail. Every
 * button also has a plain link underneath for clients that block styling.
 */
import { env } from "../config.js";

const NAVY = "#011322";
const NAVY_2 = "#08213a";
const LIME = "#6cf00c";
const INK = "#eef3f9";
const MUTED = "#a9bdd2";
const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface EmailButton {
  label: string;
  url: string;
}

export interface EmailContent {
  /** Short summary shown after the subject in the inbox list. */
  preheader: string;
  heading: string;
  /** Plain-text paragraphs (escaped for HTML automatically). */
  paragraphs: string[];
  /** Label/value rows, e.g. an amount summary. */
  details?: [string, string][];
  button?: EmailButton;
  secondaryButton?: EmailButton;
  /** Big centered code (sign-in codes). */
  code?: string;
  /** Small print after the button. */
  footnote?: string;
}

function buttonHtml(b: EmailButton, primary: boolean) {
  const bg = primary ? LIME : NAVY_2;
  const color = primary ? NAVY : INK;
  const border = primary ? LIME : "#1d3a57";
  return `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0;">
  <tr>
    <td align="center" bgcolor="${bg}" style="border-radius:4px;border:2px solid ${border};">
      <a href="${escapeHtml(b.url)}" target="_blank"
         style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${color};text-decoration:none;border-radius:4px;">
        ${escapeHtml(b.label)}
      </a>
    </td>
  </tr>
</table>`;
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const base = env.APP_BASE_URL.replace(/\/$/, "");
  const p = (t: string) =>
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${INK};">${escapeHtml(t).replace(/\n/g, "<br>")}</p>`;
  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;background:${NAVY};border-radius:4px;">
        ${c.details
          .map(
            ([k, v]) => `<tr>
              <td style="padding:8px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">${escapeHtml(k)}</td>
              <td align="right" style="padding:8px 14px;font-family:${FONT};font-size:15px;font-weight:700;color:${INK};">${escapeHtml(v)}</td>
            </tr>`,
          )
          .join("")}
      </table>`
    : "";
  const code = c.code
    ? `<div style="margin:8px 0 20px;padding:16px;background:${NAVY};border-radius:4px;text-align:center;font-family:Consolas,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:0.3em;color:${LIME};">${escapeHtml(c.code)}</div>`
    : "";
  const buttons = [c.button && buttonHtml(c.button, true), c.secondaryButton && buttonHtml(c.secondaryButton, false)].filter(Boolean).join("");
  const fallback = c.button
    ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">If the button doesn't work, copy this link into your browser:<br><a href="${escapeHtml(c.button.url)}" style="color:${LIME};word-break:break-all;">${escapeHtml(c.button.url)}</a></p>`
    : "";
  const footnote = c.footnote
    ? `<p style="margin:20px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(c.footnote)}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escapeHtml(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${NAVY};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${NAVY};">${escapeHtml(c.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${NAVY}" style="background:${NAVY};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 0 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="padding-right:12px;"><img src="${base}/apple-icon.png" width="48" height="48" alt="NFFL" style="display:block;border:0;"></td>
          <td style="font-family:${FONT};font-size:20px;font-weight:800;line-height:1.05;text-transform:uppercase;color:#ffffff;">North Florida<br>Flag League</td>
        </tr></table>
      </td></tr>
      <tr><td bgcolor="${NAVY_2}" style="background:${NAVY_2};border-top:4px solid ${LIME};padding:28px 24px;">
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:26px;line-height:1.2;font-weight:800;color:#ffffff;">${escapeHtml(c.heading)}</h1>
        ${c.paragraphs.map(p).join("")}
        ${details}
        ${code}
        ${buttons}
        ${fallback}
        ${footnote}
      </td></tr>
      <tr><td style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">
        North Florida Flag League · Jacksonville, FL · <a href="${base}" style="color:${MUTED};">${escapeHtml(base.replace(/^https?:\/\//, ""))}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((t) => [t, ""]),
    ...(c.details?.length ? [...c.details.map(([k, v]) => `${k}: ${v}`), ""] : []),
    ...(c.code ? [c.code, ""] : []),
    ...(c.button ? [`${c.button.label}: ${c.button.url}`, ""] : []),
    ...(c.secondaryButton ? [`${c.secondaryButton.label}: ${c.secondaryButton.url}`, ""] : []),
    ...(c.footnote ? [c.footnote] : []),
  ]
    .join("\n")
    .trim();

  return { html, text };
}
