"use client";

/** My account: opt in to NFFL Text Alerts. Ticking the box is the consent carriers require. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPhone } from "@nffl/shared";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";

interface Pref {
  phone: string | null;
  subscribed: boolean;
  consentAt: string | null;
  stoppedVia: string | null;
  consentText: string;
}

export function TextAlertsCard() {
  const [pref, setPref] = useState<Pref | null>(null);
  const [phone, setPhone] = useState("");
  const [agree, setAgree] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api
      .get<Pref>("/me/sms")
      .then(async (p) => {
        setPref(p);
        setAgree(p.subscribed);
        if (p.phone) setPhone(formatPhone(p.phone));
        else {
          // Start with the household phone, if there is one.
          const h = await api.get<{ household: { phone: string | null } }>("/households/me").catch(() => null);
          if (h?.household.phone) setPhone(h.household.phone);
        }
      })
      .catch(() => setPref(null));
  }, []);

  if (!pref) return null;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(null);
    const r = await run(() => api.put<Pref>("/me/sms", { phone, subscribe: agree }));
    if (r) {
      setPref(r);
      if (r.phone) setPhone(formatPhone(r.phone));
      setSaved(r.subscribed ? "You're signed up for text alerts." : "Text alerts are off.");
    }
  }

  return (
    <section className="card">
      <h2>Text message alerts</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Rainouts, schedule changes, reminders and team messages by text. Optional.{" "}
        <Link href="/text-alerts">About text alerts</Link>
      </p>
      {pref.stoppedVia === "keyword" && <div className="alert">You replied STOP, so texts are off. Tick the box below to turn them back on.</div>}
      <form className="stack" onSubmit={save}>
        <ErrorAlert error={error} />
        <label>
          Mobile number
          <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} placeholder="(904) 555-0142" />
        </label>
        <label className="check sms-consent">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            {pref.consentText} See our <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy policy</Link>.
          </span>
        </label>
        {saved && (
          <div className="alert ok" role="status">
            {saved}
          </div>
        )}
        <button className="btn small" disabled={busy || (!agree && !pref.subscribed)} style={{ alignSelf: "flex-start" }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </section>
  );
}
