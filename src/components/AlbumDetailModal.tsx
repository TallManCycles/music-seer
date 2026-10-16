"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import AlbumCover from "./AlbumCover";
import StatusBadge from "./StatusBadge";
import type { MediaType, RequestStatus } from "@/lib/types";

export interface AlbumDetailItem {
  type: MediaType;
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  releaseGroupMbid?: string;
  year?: string;
  /** Raw Cover Art Archive URL, kept for the request payload. */
  coverUrl?: string;
  /** Ready-to-use proxy URL used for display. */
  coverSrc?: string;
  subtitle?: string;
  reason?: string;
  requestId?: number;
  requestStatus?: RequestStatus;
  inLibrary?: boolean;
}

const TYPE_LABEL: Record<MediaType, string> = {
  artist: "Artist",
  album: "Album",
  track: "Track",
};

/**
 * Album detail as a centred dialog: large art, metadata, and the primary
 * Request action. Escape and the backdrop close it; focus is restored to
 * whatever opened it, and Tab is kept inside while it is open.
 */
export default function AlbumDetailModal({
  item,
  onClose,
  onRequest,
  busy,
}: {
  item: AlbumDetailItem;
  onClose: () => void;
  onRequest: (item: AlbumDetailItem) => void;
  busy?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const requested = Boolean(item.requestId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm motion-safe:animate-[overlay-in_150ms_ease-out]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${item.title} details`}
        tabIndex={-1}
        className="relative z-10 max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-white/10 bg-ink-900 p-5 shadow-2xl outline-none motion-safe:animate-[panel-in_200ms_ease-out] sm:rounded-2xl sm:p-6"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="flex flex-col gap-5 sm:flex-row">
          <AlbumCover
            src={item.coverSrc}
            alt={item.artist ? `${item.title} — ${item.artist}` : item.title}
            className="aspect-square w-40 shrink-0 self-start sm:w-48"
            rounded="rounded-xl"
          />

          <div className="min-w-0 flex-1 pr-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-white/45">
                {TYPE_LABEL[item.type] ?? item.type}
              </span>
              {item.requestStatus && <StatusBadge status={item.requestStatus} />}
              {item.inLibrary && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
                  In library
                </span>
              )}
            </div>

            <h2 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">
              {item.title}
            </h2>
            <p className="mt-1 text-sm text-white/60">
              {[item.artist, item.year].filter(Boolean).join(" · ") || "Unknown artist"}
            </p>
            {item.subtitle && <p className="mt-1 text-sm text-white/45">{item.subtitle}</p>}

            {item.reason && (
              <p className="mt-3 rounded-lg border border-accent/20 bg-accent/10 px-3 py-2 text-sm text-accent-soft">
                {item.reason}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {item.inLibrary ? (
                <span className="rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm text-white/70">
                  Already in your library
                </span>
              ) : requested ? (
                <>
                  <span className="rounded-lg bg-ink-700 px-3.5 py-2 text-sm font-medium text-white/55">
                    Requested
                  </span>
                  <Link
                    href="/requests"
                    className="rounded-lg px-2 py-2 text-sm text-accent-soft transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    Track it on Requests →
                  </Link>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => onRequest(item)}
                  disabled={busy}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-white/40 motion-reduce:transition-none"
                >
                  {busy ? "Requesting…" : "Request"}
                </button>
              )}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-white/35">
              Requests go to Lidarr first. If it cannot deliver, the album is downloaded in the
              background via yt-dlp.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
