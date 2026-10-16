"use client";

import { useState } from "react";

/** Initials fallback, matching CoverImage, for albums with no usable art. */
function initialsOf(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

/**
 * Cover art for the browse UI. Unlike CoverImage it takes a ready-made `src`
 * (a `/api/library/cover?id=…` or `/api/cover?mbid=…` URL) so both the
 * Jellyfin library and Cover Art Archive suggestions can share one component.
 *
 * The caller supplies a sized, aspect-constrained box; this fills it and keeps
 * the space reserved, so nothing shifts when the image arrives.
 */
export default function AlbumCover({
  src,
  alt,
  className = "",
  rounded = "rounded-xl",
  imgClassName = "",
}: {
  src?: string;
  alt: string;
  className?: string;
  rounded?: string;
  imgClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <div className={`relative isolate overflow-hidden bg-ink-800 ${rounded} ${className}`}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover ${imgClassName}`}
        />
      ) : (
        <div
          className="absolute inset-0 grid place-items-center"
          aria-hidden={alt ? undefined : true}
        >
          <span className="text-2xl font-semibold tracking-tight text-white/25">
            {initialsOf(alt) || "♪"}
          </span>
        </div>
      )}
    </div>
  );
}
