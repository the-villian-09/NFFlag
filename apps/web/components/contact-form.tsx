"use client";

import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api } from "@/lib/api";

export function ContactForm() {
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(() =>
      api.post("/contact", {
        name: String(f.get("name")),
        email: String(f.get("email")),
        phone: String(f.get("phone") || "") || undefined,
        topic: String(f.get("topic")),
        message: String(f.get("message")),
        website: String(f.get("website") || ""),
      }),
    );
    if (ok !== undefined) setSent(true);
  }

  if (sent) {
    return (
      <div className="alert ok" role="status">
        Thanks! Your message was sent. We'll reply by email.
      </div>
    );
  }

  return (
    <form className="stack contact-form" onSubmit={onSubmit}>
      <ErrorAlert error={error} />
      <div className="form-row">
        <label>
          Your name
          <input type="text" name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label>
          Email
          <input type="email" name="email" autoComplete="email" required />
        </label>
      </div>
      <div className="form-row">
        <label>
          Phone (optional)
          <input type="text" name="phone" autoComplete="tel" maxLength={32} />
        </label>
        <label>
          Topic
          <select name="topic" defaultValue="general">
            <option value="general">General question</option>
            <option value="registration">Registration</option>
            <option value="volunteering">Coaching / team staff</option>
          </select>
        </label>
      </div>
      <label>
        Message
        <textarea name="message" required minLength={5} maxLength={5000} rows={6} />
      </label>
      {/* Spam trap: hidden from people, filled in by bots. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <button className="btn" disabled={busy}>
        {busy ? "Sending…" : "Send message"}
      </button>
    </form>
  );
}
