"use client";

import type { Homepage } from "@nffl/shared";
import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";

type Pair = { label: string; value: string };

/** "Label | Value" per line ⇄ list of pairs. */
const pairsToText = (p: Pair[]) => p.map((x) => `${x.label} | ${x.value}`).join("\n");
function textToPairs(t: string): Pair[] {
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      return i < 0 ? { label: l, value: "" } : { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    });
}
const listToText = (l: string[]) => l.join(", ");
const textToList = (t: string) =>
  t
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Admin: edit the homepage facts. Changes show on the site within about a minute. */
export function HomepageForm({ initial }: { initial: Homepage }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    const body: Homepage = {
      registerButton: s("registerButton"),
      tagline: s("tagline"),
      boysAgeRange: s("boysAgeRange"),
      girlsAgeRange: s("girlsAgeRange"),
      keyDates: textToPairs(s("keyDates")),
      practiceDays: s("practiceDays"),
      practiceTimes: s("practiceTimes"),
      gameDays: s("gameDays"),
      gameDates: s("gameDates"),
      boysDivisions: textToList(s("boysDivisions")),
      girlsDivisions: textToList(s("girlsDivisions")),
      registrationFee: s("registrationFee"),
      registrationFeeNote: s("registrationFeeNote"),
      leagueFees: textToPairs(s("leagueFees")),
      gateFees: textToPairs(s("gateFees")),
      ctaTitle: s("ctaTitle"),
      ctaText: s("ctaText"),
    };
    if ((await run(() => api.put("/admin/content/settings/homepage", body))) !== undefined) setSaved(true);
  }

  const h = initial;
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Homepage</h2>
      <p className="muted" style={{ margin: 0 }}>
        Dates, schedule, divisions and fees shown on the home page. Changes appear within about a minute.{" "}
        <a href="/" target="_blank" rel="noopener noreferrer">
          View homepage
        </a>
      </p>
      <form className="stack" onSubmit={onSubmit}>
        <ErrorAlert error={error} />
        <fieldset>
          <legend>Top of the page</legend>
          <div className="form-row">
            <label>
              Register button
              <input type="text" name="registerButton" required maxLength={60} defaultValue={h.registerButton} />
            </label>
            <label>
              Tagline
              <input type="text" name="tagline" maxLength={120} defaultValue={h.tagline} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Boys ages (blue side)
              <input type="text" name="boysAgeRange" maxLength={40} defaultValue={h.boysAgeRange} />
            </label>
            <label>
              Girls ages (pink side)
              <input type="text" name="girlsAgeRange" maxLength={40} defaultValue={h.girlsAgeRange} />
            </label>
          </div>
          <label>
            Key dates (green band), one per line as <code>Label | Date</code>
            <textarea name="keyDates" rows={4} defaultValue={pairsToText(h.keyDates)} />
            <span className="hint">Up to 6. Example: Draft | Jan 4, 2027</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Weekly schedule</legend>
          <div className="form-row">
            <label>
              Practice days
              <input type="text" name="practiceDays" maxLength={80} defaultValue={h.practiceDays} />
            </label>
            <label>
              Practice times
              <input type="text" name="practiceTimes" maxLength={80} defaultValue={h.practiceTimes} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Game days
              <input type="text" name="gameDays" maxLength={80} defaultValue={h.gameDays} />
            </label>
            <label>
              Game season
              <input type="text" name="gameDates" maxLength={80} defaultValue={h.gameDates} />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Divisions</legend>
          <label>
            Boys divisions, separated by commas
            <input type="text" name="boysDivisions" defaultValue={listToText(h.boysDivisions)} />
          </label>
          <label>
            Girls divisions, separated by commas
            <input type="text" name="girlsDivisions" defaultValue={listToText(h.girlsDivisions)} />
          </label>
          <span className="hint">These are the labels on the homepage. Registration uses the divisions set up under Seasons.</span>
        </fieldset>
        <fieldset>
          <legend>Fees</legend>
          <div className="form-row">
            <label>
              Registration fee
              <input type="text" name="registrationFee" maxLength={20} defaultValue={h.registrationFee} />
            </label>
            <label>
              Under the fee
              <input type="text" name="registrationFeeNote" maxLength={40} defaultValue={h.registrationFeeNote} />
            </label>
          </div>
          <div className="form-row">
            <label>
              League fees, one per line as <code>Label | Amount</code>
              <textarea name="leagueFees" rows={3} defaultValue={pairsToText(h.leagueFees)} />
            </label>
            <label>
              Gate fees, one per line as <code>Label | Amount</code>
              <textarea name="gateFees" rows={3} defaultValue={pairsToText(h.gateFees)} />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Blue band at the bottom</legend>
          <div className="form-row">
            <label>
              Heading
              <input type="text" name="ctaTitle" maxLength={60} defaultValue={h.ctaTitle} />
            </label>
            <label>
              Text
              <input type="text" name="ctaText" maxLength={160} defaultValue={h.ctaText} />
            </label>
          </div>
        </fieldset>
        {saved && (
          <div className="alert ok" role="status">
            Saved. The homepage updates within about a minute.
          </div>
        )}
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save homepage"}
        </button>
      </form>
    </section>
  );
}
