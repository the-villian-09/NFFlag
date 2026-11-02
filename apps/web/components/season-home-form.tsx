"use client";

/** Admin → Site content: the in-season home page and the replaceable photos. */
import { IMAGE_SLOT_KEYS, IMAGE_SLOTS, siteImageUrl, type ImageSlot, type ImageSlots, type SeasonHome, type Sponsor } from "@nffl/shared";
import { useId, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";
import { uploadPhoto } from "@/lib/upload-photo";

/** A file picker styled as a button. */
function PhotoPicker({ label, busy, onPick, small }: { label: string; busy: boolean; onPick: (f: File) => void; small?: boolean }) {
  const id = useId();
  return (
    <>
      <input
        id={id}
        type="file"
        className="sr-only"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onPick(f);
        }}
      />
      <label htmlFor={id} className={`btn ${small ? "small ghost" : "small"}`} aria-disabled={busy}>
        {busy ? "Uploading…" : label}
      </label>
    </>
  );
}

export function SeasonHomeForm({ initial }: { initial: SeasonHome }) {
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [sponsors, setSponsors] = useState<Sponsor[]>(initial.sponsors);
  const [logoBusy, setLogoBusy] = useState<number | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    const on = (k: string) => f.get(k) === "on";
    const body: SeasonHome = {
      mode: s("mode") as SeasonHome["mode"],
      heroKicker: s("heroKicker"),
      statusText: s("statusText"),
      whereText: s("whereText"),
      passesLabel: s("passesLabel"),
      ticketsLabel: s("ticketsLabel"),
      ticketsUrl: s("ticketsUrl").trim(),
      noGamesTitle: s("noGamesTitle"),
      noGamesText: s("noGamesText"),
      showYourTeam: on("showYourTeam"),
      showScores: on("showScores"),
      scoresTitle: s("scoresTitle"),
      showStandings: on("showStandings"),
      standingsTitle: s("standingsTitle"),
      playoffSpots: Number(s("playoffSpots") || 0),
      playoffNote: s("playoffNote"),
      showNews: on("showNews"),
      newsTitle: s("newsTitle"),
      showSponsors: on("showSponsors"),
      sponsorsTitle: s("sponsorsTitle"),
      sponsors: sponsors.filter((x) => x.name.trim()).map((x) => ({ ...x, name: x.name.trim(), url: x.url.trim() })),
    };
    if ((await run(() => api.put("/admin/content/settings/seasonHome", body))) !== undefined) setSaved(true);
  }

  async function addLogo(i: number, file: File) {
    setLogoBusy(i);
    setLogoError(null);
    try {
      const img = await uploadPhoto("POST", "/admin/content/images?use=logo", file, 800);
      setSponsors((list) => list.map((x, j) => (j === i ? { ...x, logoId: img.id } : x)));
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : "The upload didn't work.");
    } finally {
      setLogoBusy(null);
    }
  }

  const h = initial;
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>In-season home page</h2>
      <p className="muted" style={{ margin: 0 }}>
        The home page once games start: the next game day, each family&rsquo;s team, latest scores, standings, league news and sponsors. Games, scores and standings come from
        the schedule; this sets the wording and what to show.
      </p>
      <form className="stack" onSubmit={onSubmit}>
        <ErrorAlert error={error} />
        <fieldset>
          <legend>Which home page</legend>
          <label>
            Show
            <select name="mode" defaultValue={h.mode}>
              <option value="auto">Automatic: in-season page while the current season is “in season” or “playoffs”</option>
              <option value="season">Always the in-season page</option>
              <option value="registration">Always the registration page</option>
            </select>
            <span className="hint">Set the season&rsquo;s status under Seasons.</span>
          </label>
        </fieldset>
        <fieldset>
          <legend>Top of the page</legend>
          <div className="form-row">
            <label>
              Small heading
              <input type="text" name="heroKicker" maxLength={40} defaultValue={h.heroKicker} placeholder="Next game day" />
            </label>
            <label>
              Status
              <input type="text" name="statusText" maxLength={60} defaultValue={h.statusText} placeholder="Games on as scheduled" />
              <span className="hint">Green tag above the date. Leave blank to hide. Rainouts and delays also go in the announcement banner.</span>
            </label>
          </div>
          <label>
            Where
            <input type="text" name="whereText" maxLength={80} defaultValue={h.whereText} placeholder="Leave blank to list the fields from the schedule" />
          </label>
          <div className="form-row">
            <label>
              Season pass button
              <input type="text" name="passesLabel" required maxLength={40} defaultValue={h.passesLabel} />
              <span className="hint">Links to the season pass page set under Seasons; hidden without one.</span>
            </label>
            <label>
              Day tickets button
              <input type="text" name="ticketsLabel" required maxLength={40} defaultValue={h.ticketsLabel} />
            </label>
            <label>
              Day tickets link
              <input type="url" inputMode="url" name="ticketsUrl" maxLength={500} defaultValue={h.ticketsUrl} placeholder="https://…" pattern="https://.*" title="Starts with https://" />
              <span className="hint">Your TixFlo page. Leave blank to hide the button.</span>
            </label>
          </div>
          <div className="form-row">
            <label>
              When no games are coming up: heading
              <input type="text" name="noGamesTitle" required maxLength={60} defaultValue={h.noGamesTitle} />
            </label>
            <label>
              Text
              <input type="text" name="noGamesText" maxLength={200} defaultValue={h.noGamesText} />
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Sections</legend>
          <label className="check">
            <input type="checkbox" name="showYourTeam" defaultChecked={h.showYourTeam} /> Your team (signed-in families see their child&rsquo;s team; others get a team search)
          </label>
          <div className="form-row">
            <label className="check">
              <input type="checkbox" name="showScores" defaultChecked={h.showScores} /> Latest scores
            </label>
            <label>
              Heading
              <input type="text" name="scoresTitle" required maxLength={40} defaultValue={h.scoresTitle} />
            </label>
          </div>
          <div className="form-row">
            <label className="check">
              <input type="checkbox" name="showStandings" defaultChecked={h.showStandings} /> Standings (top 3 per division)
            </label>
            <label>
              Heading
              <input type="text" name="standingsTitle" required maxLength={40} defaultValue={h.standingsTitle} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Playoff spots per division
              <input type="number" name="playoffSpots" min={0} max={16} defaultValue={h.playoffSpots} />
              <span className="hint">0 hides the playoff race panel.</span>
            </label>
            <label>
              Playoff note
              <input type="text" name="playoffNote" maxLength={160} defaultValue={h.playoffNote} placeholder="Top 4 make the playoffs. Semifinals Dec 5." />
            </label>
          </div>
          <div className="form-row">
            <label className="check">
              <input type="checkbox" name="showNews" defaultChecked={h.showNews} /> League news (latest 3 posts)
            </label>
            <label>
              Heading
              <input type="text" name="newsTitle" required maxLength={40} defaultValue={h.newsTitle} />
              <span className="hint">
                Write posts under <a href="/admin/news">Admin → League news</a>.
              </span>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Sponsors</legend>
          <div className="form-row">
            <label className="check">
              <input type="checkbox" name="showSponsors" defaultChecked={h.showSponsors} /> Show sponsors
            </label>
            <label>
              Heading
              <input type="text" name="sponsorsTitle" required maxLength={60} defaultValue={h.sponsorsTitle} />
            </label>
          </div>
          <ErrorAlert error={logoError} />
          <div className="sponsor-list">
            {sponsors.map((sp, i) => (
              <div key={i} className="sponsor-row">
                <div className="sponsor-logo">
                  {sp.logoId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={siteImageUrl(sp.logoId)} alt="" />
                  ) : (
                    <span>No logo</span>
                  )}
                </div>
                <label>
                  Name
                  <input type="text" value={sp.name} maxLength={60} onChange={(e) => setSponsors((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </label>
                <label>
                  Website
                  <input
                    type="url"
                    inputMode="url"
                    value={sp.url}
                    maxLength={500}
                    placeholder="https://…"
                    pattern="https://.*"
                    title="Starts with https://"
                    onChange={(e) => setSponsors((l) => l.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                  />
                </label>
                <span className="sponsor-actions">
                  <PhotoPicker small label={sp.logoId ? "Replace logo" : "Add logo"} busy={logoBusy === i} onPick={(f) => addLogo(i, f)} />
                  {sp.logoId && (
                    <button type="button" className="link-btn" onClick={() => setSponsors((l) => l.map((x, j) => (j === i ? { ...x, logoId: null } : x)))}>
                      Remove logo
                    </button>
                  )}
                  <button type="button" className="link-btn" onClick={() => setSponsors((l) => l.filter((_, j) => j !== i))}>
                    Remove sponsor
                  </button>
                </span>
              </div>
            ))}
          </div>
          {sponsors.length < 16 && (
            <button type="button" className="btn ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setSponsors((l) => [...l, { name: "", url: "", logoId: null }])}>
              Add sponsor
            </button>
          )}
          <span className="hint">Without a logo the sponsor&rsquo;s name is shown. Logos work best on a transparent or dark background.</span>
        </fieldset>
        {saved && (
          <div className="alert ok" role="status">
            Saved. The home page updates within about a minute.
          </div>
        )}
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : "Save in-season home page"}
        </button>
      </form>
    </section>
  );
}

/** Replace the built-in home page photos, or go back to them. */
export function PhotosCard({ initial }: { initial: ImageSlots }) {
  const [slots, setSlots] = useState<ImageSlots>(initial);
  const [busy, setBusy] = useState<ImageSlot | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function replace(slot: ImageSlot, file: File) {
    setBusy(slot);
    setError(null);
    try {
      const img = await uploadPhoto("PUT", `/admin/content/images/slots/${slot}`, file);
      setSlots((s) => ({ ...s, [slot]: img.id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't work.");
    } finally {
      setBusy(null);
    }
  }
  async function reset(slot: ImageSlot) {
    setBusy(slot);
    setError(null);
    try {
      await api.del(`/admin/content/images/slots/${slot}`);
      setSlots((s) => ({ ...s, [slot]: null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Photos</h2>
      <p className="muted" style={{ margin: 0 }}>
        Replace the home page photos with your own. Until you upload one, the built-in photo is used. Photos are resized and saved without hidden details such as location.
      </p>
      <ErrorAlert error={error} />
      <div className="photo-slots">
        {IMAGE_SLOT_KEYS.map((k) => {
          const id = slots[k];
          return (
            <div key={k} className="photo-slot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={id ? siteImageUrl(id) : IMAGE_SLOTS[k].fallback} alt="" />
              <div>
                <strong>{IMAGE_SLOTS[k].label}</strong>
                <span className={`status ${id ? "ok" : "muted"}`}>{id ? "Your photo" : "Built-in photo"}</span>
                <span className="hint">{IMAGE_SLOTS[k].hint}</span>
                <span className="doc-actions">
                  <PhotoPicker label={id ? "Replace" : "Upload photo"} busy={busy === k} onPick={(f) => replace(k, f)} />
                  {id && (
                    <button type="button" className="link-btn" disabled={busy === k} onClick={() => reset(k)}>
                      Use built-in photo
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
