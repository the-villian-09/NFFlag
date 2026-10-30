"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "./api";

/**
 * Loads the signed-in user and routes them to the right place:
 * not signed in → /sign-in; MFA not set up → /setup-mfa.
 */
export function useMe({ allowIncompleteMfa = false } = {}) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Me>("/me")
      .then((m) => {
        if (cancelled) return;
        if (!m.mfa.complete && !allowIncompleteMfa) {
          router.replace("/setup-mfa");
          return;
        }
        setMe(m);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.code === "EMAIL_NOT_VERIFIED")) {
          router.replace("/sign-in");
          return;
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, allowIncompleteMfa]);

  return { me, loading };
}

export function isAdmin(me: Me | null) {
  return !!me && (me.roles.includes("super_admin") || me.roles.includes("league_admin"));
}
