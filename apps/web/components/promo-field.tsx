"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";

/** "Have a promo code?" box at checkout. Shows the applied code with a Remove link. */
export function PromoField({ applied, onApply, disabled }: { applied: string | null; onApply: (code: string | null) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(value: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onApply(value);
      setCode("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't apply that code.");
    } finally {
      setBusy(false);
    }
  }

  if (applied)
    return (
      <p className="promo-applied">
        Promo code <strong>{applied}</strong> applied.{" "}
        <button type="button" className="link-btn" disabled={busy || disabled} onClick={() => run(null)}>
          Remove
        </button>
      </p>
    );
  if (!open)
    return (
      <button type="button" className="link-btn" disabled={disabled} onClick={() => setOpen(true)} style={{ marginTop: 8 }}>
        Have a promo code?
      </button>
    );
  return (
    <form
      className="promo-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) void run(code);
      }}
    >
      <label>
        Promo code
        <span className="promo-row">
          <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={30} autoCapitalize="characters" autoComplete="off" spellCheck={false} autoFocus />
          <button className="btn small" disabled={busy || !code.trim()}>
            {busy ? "Checking…" : "Apply"}
          </button>
        </span>
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
