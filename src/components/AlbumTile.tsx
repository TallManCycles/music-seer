"use client";

import type { ReactNode } from "react";
import AlbumCover from "./AlbumCover";

/**
 * One album in a shelf: square art, hover-revealed quick request, title and
 * artist beneath. The whole tile opens the detail panel; the quick action is a
 * sibling button (never nested) so both stay keyboard reachable.
 */
export default function AlbumTile({
  title,
  artist,
  year,
  coverSrc,
  onOpen,
  onQuickRequest,
  quickBusy,
  quickDone,
  badge,
  className = "",
}: {
  title: string;
  artist?: string;
  year?: string;
  coverSrc?: string;
  onOpen: () => void;
  onQuickRequest?: () => void;
  quickBusy?: boolean;
  quickDone?: boolean;
  badge?: ReactNode;
  className?: string;
}) {
  const coverAlt = artist ? `${title} — ${artist}` : title;

  return (
    <article className={`group relative ${className}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${title}${artist ? ` by ${artist}` : ""} — open details`}
        className="block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950"
      >
        <div className="relative aspect-square w-full overflow-hidden rounded-xl ring-1 ring-white/5 transition group-hover:ring-white/15 group-focus-within:ring-accent/40 motion-reduce:transition-none">
          <AlbumCover
            src={coverSrc}
            alt={coverAlt}
            rounded=""
            className="h-full w-full"
            imgClassName="motion-safe:transition motion-safe:duration-500 motion-safe:group-hover:scale-[1.04] motion-reduce:transition-none"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/60 via-transparent to-transparent opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
          />
          {badge && (
            <span className="absolute left-2 top-2 flex flex-wrap gap-1">{badge}</span>
          )}
        </div>
        <div className="mt-2.5 min-w-0">
          <p className="truncate text-sm font-medium text-white/90 group-hover:text-white">
            {title}
          </p>
          <p className="mt-0.5 truncate text-xs text-white/45">
            {[artist, year].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
      </button>

      {onQuickRequest && !quickDone && (
        <button
          type="button"
          onClick={onQuickRequest}
          disabled={quickBusy}
          aria-label={`Request ${title}`}
          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-accent text-white shadow-lg ring-1 ring-white/25 transition opacity-0 hover:bg-accent-soft focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 disabled:cursor-not-allowed disabled:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 motion-safe:hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100"
        >
          {quickBusy ? (
            <span className="h-3.5 w-3.5 animate-pulse-soft rounded-full bg-white/85" />
          ) : (
            <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden fill="none">
              <path
                d="M8 3.5v9M3.5 8h9"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      )}
    </article>
  );
}
