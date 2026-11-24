"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Silent looping video over a banner photo. The photo stays underneath, so it
 * shows while the video loads, if it can't play, and for visitors who've asked
 * their device for less motion (the video isn't loaded for them at all).
 */
export function HeroVideo({ src, phoneSrc, className }: { src: string; phoneSrc?: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setShow(!reduce.matches);
    update();
    reduce.addEventListener("change", update);
    return () => reduce.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // React doesn't always put "muted" in the page, and phones only autoplay muted video.
    v.muted = true;
    v.play().catch(() => {});
  }, [show]);

  if (!show) return null;
  return (
    <video ref={ref} className={className} autoPlay muted loop playsInline preload="auto" aria-hidden="true" tabIndex={-1}>
      {phoneSrc && <source src={phoneSrc} type="video/mp4" media="(max-width: 960px)" />}
      <source src={src} type="video/mp4" />
    </video>
  );
}
