"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Phones only: a slim bar pinned to the bottom of the home page so Register is
 * always a thumb away. Signed-in parents go straight to registration.
 */
export function RegisterBar({ title, detail }: { title: string; detail: string }) {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setSignedIn(!!s?.session))
      .catch(() => {});
  }, []);
  return (
    <div className="register-bar" role="region" aria-label="Register">
      <span className="register-bar-text">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </span>
      <Link href={signedIn ? "/register" : "/sign-up"} className="btn small">
        {signedIn ? "Register" : "Create account"}
      </Link>
    </div>
  );
}
