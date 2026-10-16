"use client";

import { useState } from "react";

export default function CoverImage({
  mbid,
  alt,
  size = 250,
  className = "",
}: {
  mbid?: string;
  alt: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = alt
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  if (!mbid || failed) {
    return (
      <div
        className={`grid place-items-center bg-ink-800 text-white/25 ${className}`}
        aria-hidden={!alt}
      >
        <span className="text-2xl font-semibold tracking-tight">{initials || "♪"}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/cover?mbid=${mbid}&size=${size}`}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`bg-ink-800 object-cover ${className}`}
    />
  );
}
