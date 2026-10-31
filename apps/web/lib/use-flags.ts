"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/** Release switches that are on (from /flags). null while loading. */
export function useFlags() {
  const [flags, setFlags] = useState<Set<string> | null>(null);
  useEffect(() => {
    api
      .get<{ enabled: string[] }>("/flags")
      .then((r) => setFlags(new Set(r.enabled)))
      .catch(() => setFlags(new Set()));
  }, []);
  return flags;
}
