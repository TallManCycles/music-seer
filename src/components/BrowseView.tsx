"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SearchView from "./SearchView";
import AlbumTile from "./AlbumTile";
import AlbumCover from "./AlbumCover";
import AlbumDetailModal, { type AlbumDetailItem } from "./AlbumDetailModal";
import StatusBadge from "./StatusBadge";
import Toast from "./Toast";
import type { RequestStatus } from "@/lib/types";

interface DiscoverAlbum {
  type: "album";
  mbid: string;
  releaseGroupMbid?: string;
  title: string;
  artist: string;
  artistMbid?: string;
  year?: string;
  coverUrl?: string;
  subtitle?: string;
}

interface Suggestion {
  album: DiscoverAlbum;
  reason: string;
  requestId?: number;
  requestStatus?: RequestStatus;
}

interface DiscoverArtist {
  type: "artist";
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  year?: string;
  /** e.g. "Group · GB" */
  subtitle?: string;
}

interface NewArtist {
  artist: DiscoverArtist;
  reason: string;
  requestId?: number;
  requestStatus?: RequestStatus;
}

/** A recently released album from an artist already in the library. */
interface NewRelease {
  album: DiscoverAlbum;
  reason: string;
  requestId?: number;
  requestStatus?: RequestStatus;
}

/** A globally popular release. Keyed by release mbid; `releaseGroupMbid` is absent. */
interface ChartEntry {
  album: DiscoverAlbum;
  reason: string;
  listenCount?: number;
  requestId?: number;
  requestStatus?: RequestStatus;
}

interface DiscoverPayload {
  configured: boolean;
  libraryAlbums: number;
  libraryArtists: number;
  suggestions: Suggestion[];
  /** Artists the listener does not own yet, suggested from their genres. */
  newArtists?: NewArtist[];
  /** Recently released records from artists already in the library. */
  newReleases?: NewRelease[];
  /** Globally popular releases from ListenBrainz. */
  charts?: ChartEntry[];
  /** The genres the suggestions came from, e.g. ["rock", "pop rock"]. */
  basedOn?: string[];
  error?: string;
  /** Why there is nothing to suggest, when there is a fixable reason. */
  note?: string;
}

/** Per-album request state we have learned this session, keyed `type:mbid`. */
interface Override {
  busy?: boolean;
  requestId?: number;
  requestStatus?: RequestStatus;
}

const keyOf = (type: string, mbid: string) => `${type}:${mbid}`;

/**
 * Cover art for a suggestion. The API returns a finished URL — charts are keyed
 * by release and albums by release group, and building it here got that wrong
 * for charts (a guaranteed 404). Fall back to the release-group form only if the
 * API did not supply one.
 */
function suggestionCover(album: DiscoverAlbum): string {
  if (album.coverUrl) return album.coverUrl;
  const mbid = album.releaseGroupMbid ?? album.mbid;
  return `/api/cover?mbid=${mbid}&size=300`;
}

/** "rock and pop rock" from ["rock", "pop rock"]. */
function joinGenres(genres: string[]): string {
  if (genres.length <= 1) return genres[0] ?? "";
  return `${genres.slice(0, -1).join(", ")} and ${genres[genres.length - 1]}`;
}

export default function BrowseView() {
  const [discover, setDiscover] = useState<DiscoverPayload | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [detail, setDetail] = useState<AlbumDetailItem | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "info" | "error" } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/discover?limit=24", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data: DiscoverPayload = await res.json();
        if (!res.ok) throw new Error(data.error ?? "could not build suggestions");
        setDiscover(data);
        setDiscoverError(data.error ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setDiscoverError(err instanceof Error ? err.message : "could not build suggestions");
      }
    })();
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((message: string, tone: "info" | "error" = "info") => {
    setToast({ message, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const requestAlbum = useCallback(
    async (item: AlbumDetailItem) => {
      const key = keyOf(item.type, item.mbid);
      setOverrides((o) => ({ ...o, [key]: { ...o[key], busy: true } }));
      try {
        const res = await fetch("/api/requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: item.type,
            mbid: item.mbid,
            title: item.title,
            artist: item.artist,
            artistMbid: item.artistMbid,
            releaseGroupMbid: item.releaseGroupMbid,
            year: item.year,
            coverUrl: item.coverUrl,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "request failed");

        const patch: Override = {
          busy: false,
          requestId: data.request?.id,
          requestStatus: data.request?.status,
        };
        setOverrides((o) => ({ ...o, [key]: patch }));
        setDetail((d) =>
          d && keyOf(d.type, d.mbid) === key
            ? { ...d, requestId: patch.requestId, requestStatus: patch.requestStatus }
            : d
        );
        showToast(
          data.duplicate
            ? `“${item.title}” is already requested.`
            : `Requested “${item.title}” — downloading in the background.`
        );
      } catch (err) {
        setOverrides((o) => ({ ...o, [key]: { ...o[key], busy: false } }));
        showToast(err instanceof Error ? err.message : "request failed", "error");
      }
    },
    [showToast]
  );

  const requestArtist = useCallback(
    async (artist: DiscoverArtist) => {
      const key = keyOf("artist", artist.mbid);
      setOverrides((o) => ({ ...o, [key]: { ...o[key], busy: true } }));
      try {
        const res = await fetch("/api/requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "artist",
            mbid: artist.mbid,
            title: artist.title,
            artist: artist.title,
            artistMbid: artist.mbid,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "request failed");

        setOverrides((o) => ({
          ...o,
          [key]: {
            busy: false,
            requestId: data.request?.id,
            requestStatus: data.request?.status,
          },
        }));
        showToast(
          data.duplicate
            ? `“${artist.title}” is already requested.`
            : `Requested “${artist.title}” — Lidarr is searching for it now.`
        );
      } catch (err) {
        setOverrides((o) => ({ ...o, [key]: { ...o[key], busy: false } }));
        showToast(err instanceof Error ? err.message : "request failed", "error");
      }
    },
    [showToast]
  );

  const openSuggestion = useCallback(
    (s: Suggestion) => {
      const album = s.album;
      const ov = overrides[keyOf(album.type, album.mbid)];
      setDetail({
        type: album.type,
        mbid: album.mbid,
        title: album.title,
        artist: album.artist,
        artistMbid: album.artistMbid,
        releaseGroupMbid: album.releaseGroupMbid,
        year: album.year,
        coverUrl: album.coverUrl,
        coverSrc: suggestionCover(album),
        subtitle: album.subtitle,
        reason: s.reason,
        requestId: ov?.requestId ?? s.requestId,
        requestStatus: ov?.requestStatus ?? s.requestStatus,
      });
    },
    [overrides]
  );

  const needsSetup = discover?.configured === false;

  const detailKey = detail ? keyOf(detail.type, detail.mbid) : null;
  const detailBusy = detailKey ? overrides[detailKey]?.busy : false;

  return (
    <div>
      <section className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br from-accent/15 via-ink-900/60 to-ink-900/40 px-5 py-7 sm:px-8 sm:py-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent-soft">
          Music request manager
        </p>
        <h1 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Your library, and what to add next
        </h1>
        <p className="mt-2 max-w-prose text-sm text-white/55">
          Browse the albums Jellyfin already holds, then request the ones that are missing. Lidarr
          gets first crack; yt-dlp fills the gaps.
        </p>
        <div className="mt-5">
          <SearchView embedded />
        </div>
        <Link
          href="/library"
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-sm font-medium text-white/85 transition hover:border-white/20 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 motion-reduce:transition-none"
        >
          Browse all your albums →
        </Link>
        {discover && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/45">
            <span>{discover.libraryAlbums} albums in your library</span>
            <span>{discover.libraryArtists} artists</span>
            {discover.suggestions.length > 0 && (
              <span>{discover.suggestions.length} suggestions</span>
            )}
          </div>
        )}
      </section>

      {needsSetup && (
        <section className="mt-8 rounded-xl border border-accent/20 bg-accent/10 p-5">
          <h2 className="text-base font-semibold">Connect Jellyfin to browse your library</h2>
          <p className="mt-1 text-sm text-white/60">
            The library and suggestions are built from what Jellyfin can see. Add your server and
            credentials to get started.
          </p>
          <Link
            href="/settings"
            className="mt-3 inline-block rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 motion-reduce:transition-none"
          >
            Open settings
          </Link>
        </section>
      )}

      {discoverError && (
        <Notice tone="warn">Suggestions are unavailable right now: {discoverError}</Notice>
      )}

      {!needsSetup && (
        <section className="mt-12">
          <header className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">Suggested for you</h2>
            <p className="mt-0.5 text-sm text-white/45">
              Based on the artists already in your library — one tap to request.
            </p>
          </header>

          {!discover ? (
            <ShelfSkeleton count={6} />
          ) : discover.suggestions.length === 0 ? (
            <EmptyState
              title="Nothing to suggest yet"
              body={
                discover.note ??
                "Add a few albums to your library and suggestions will appear here."
              }
            />
          ) : (
            <ul className="flex snap-x gap-4 overflow-x-auto pb-2 scrollbar-none">
              {discover.suggestions.map((s) => {
                const ov = overrides[keyOf(s.album.type, s.album.mbid)];
                const requestId = ov?.requestId ?? s.requestId;
                const requestStatus = ov?.requestStatus ?? s.requestStatus;
                return (
                  <li key={s.album.mbid} className="w-40 shrink-0 snap-start sm:w-44">
                    <AlbumTile
                      title={s.album.title}
                      artist={s.album.artist}
                      year={s.album.year}
                      coverSrc={suggestionCover(s.album)}
                      onOpen={() => openSuggestion(s)}
                      onQuickRequest={
                        requestId ? undefined : () => void requestAlbum({ ...s.album, coverSrc: suggestionCover(s.album) })
                      }
                      quickBusy={Boolean(ov?.busy)}
                      quickDone={Boolean(requestId)}
                      badge={
                        requestId ? (
                          requestStatus ? (
                            <StatusBadge status={requestStatus} />
                          ) : (
                            <span className="rounded-full bg-ink-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-soft ring-1 ring-inset ring-accent/30 backdrop-blur">
                              Requested
                            </span>
                          )
                        ) : undefined
                      }
                    />
                    <p className="mt-2 line-clamp-2 text-xs leading-snug text-white/40">
                      {s.reason}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!needsSetup && (!discover || (discover.newReleases ?? []).length > 0) && (
        <section className="mt-12">
          <header className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">New releases</h2>
            <p className="mt-0.5 text-sm text-white/45">
              Recent records from artists you already have — one tap to request.
            </p>
          </header>

          {!discover ? (
            <ShelfSkeleton count={6} />
          ) : (
            <ul className="flex snap-x gap-4 overflow-x-auto pb-2 scrollbar-none">
              {(discover.newReleases ?? []).map((item) => {
                const album = item.album;
                const ov = overrides[keyOf(album.type, album.mbid)];
                const requestId = ov?.requestId ?? item.requestId;
                const requestStatus = ov?.requestStatus ?? item.requestStatus;
                return (
                  <li key={album.mbid} className="w-40 shrink-0 snap-start sm:w-44">
                    <AlbumTile
                      title={album.title}
                      artist={album.artist}
                      year={album.year}
                      coverSrc={suggestionCover(album)}
                      onOpen={() => openSuggestion(item)}
                      onQuickRequest={
                        requestId ? undefined : () => void requestAlbum({ ...album, coverSrc: suggestionCover(album) })
                      }
                      quickBusy={Boolean(ov?.busy)}
                      quickDone={Boolean(requestId)}
                      badge={
                        requestId ? (
                          requestStatus ? (
                            <StatusBadge status={requestStatus} />
                          ) : (
                            <span className="rounded-full bg-ink-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-soft ring-1 ring-inset ring-accent/30 backdrop-blur">
                              Requested
                            </span>
                          )
                        ) : undefined
                      }
                    />
                    <p className="mt-2 line-clamp-2 text-xs leading-snug text-white/40">
                      {item.reason}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!needsSetup && (
        <section className="mt-12">
          <header className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">New artists</h2>
            <p className="mt-0.5 text-sm text-white/45">
              {discover?.basedOn && discover.basedOn.length > 0
                ? `Because you listen to ${joinGenres(discover.basedOn)} — one tap to request.`
                : "Artists outside your library you might like — one tap to request."}
            </p>
          </header>

          {!discover ? (
            <ShelfSkeleton count={6} />
          ) : (discover.newArtists ?? []).length === 0 ? (
            <EmptyState
              title="No new artists yet"
              body="Add a few albums to your library and we will suggest artists you do not own."
            />
          ) : (
            <ul className="flex snap-x gap-4 overflow-x-auto pb-2 scrollbar-none">
              {(discover.newArtists ?? []).map((item) => {
                const artist = item.artist;
                const key = keyOf(artist.type, artist.mbid);
                const ov = overrides[key];
                const requestId = ov?.requestId ?? item.requestId;
                const requestStatus = ov?.requestStatus ?? item.requestStatus;
                const busy = Boolean(ov?.busy);
                return (
                  <li key={artist.mbid} className="w-40 shrink-0 snap-start sm:w-44">
                    <div className="relative aspect-square w-full overflow-hidden rounded-xl ring-1 ring-white/5">
                      <AlbumCover alt={artist.title} rounded="" className="h-full w-full" />
                      {requestId && (
                        <span className="absolute left-2 top-2 flex flex-wrap gap-1">
                          {requestStatus ? (
                            <StatusBadge status={requestStatus} />
                          ) : (
                            <span className="rounded-full bg-ink-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-soft ring-1 ring-inset ring-accent/30 backdrop-blur">
                              Requested
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="mt-2.5 min-w-0">
                      <p className="truncate text-sm font-medium text-white/90">{artist.title}</p>
                      <p className="mt-0.5 truncate text-xs text-white/45">
                        {artist.subtitle || "Artist"}
                      </p>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-snug text-white/40">
                      {item.reason}
                    </p>
                    <button
                      type="button"
                      disabled={busy || Boolean(requestId)}
                      onClick={() => void requestArtist(artist)}
                      aria-label={`Request ${artist.title}`}
                      className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-white/40 motion-reduce:transition-none"
                    >
                      {requestId ? "Requested" : busy ? "Requesting…" : "Request"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!needsSetup && (!discover || (discover.charts ?? []).length > 0) && (
        <section className="mt-12">
          <header className="mb-4">
            <h2 className="text-lg font-semibold tracking-tight">Charts</h2>
            <p className="mt-0.5 text-sm text-white/45">
              What people are listening to on ListenBrainz this week — not based on your library.
            </p>
          </header>

          {!discover ? (
            <ShelfSkeleton count={6} />
          ) : (
            <ul className="flex snap-x gap-4 overflow-x-auto pb-2 scrollbar-none">
              {(discover.charts ?? []).map((item) => {
                const album = item.album;
                const ov = overrides[keyOf(album.type, album.mbid)];
                const requestId = ov?.requestId ?? item.requestId;
                const requestStatus = ov?.requestStatus ?? item.requestStatus;
                return (
                  <li key={album.mbid} className="w-40 shrink-0 snap-start sm:w-44">
                    <AlbumTile
                      title={album.title}
                      artist={album.artist}
                      year={album.year}
                      coverSrc={suggestionCover(album)}
                      onOpen={() => openSuggestion(item)}
                      onQuickRequest={
                        requestId ? undefined : () => void requestAlbum({ ...album, coverSrc: suggestionCover(album) })
                      }
                      quickBusy={Boolean(ov?.busy)}
                      quickDone={Boolean(requestId)}
                      badge={
                        requestId ? (
                          requestStatus ? (
                            <StatusBadge status={requestStatus} />
                          ) : (
                            <span className="rounded-full bg-ink-950/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-soft ring-1 ring-inset ring-accent/30 backdrop-blur">
                              Requested
                            </span>
                          )
                        ) : undefined
                      }
                    />
                    <p className="mt-2 line-clamp-2 text-xs leading-snug text-white/40">
                      {item.reason}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {detail && (
        <AlbumDetailModal
          item={detail}
          busy={Boolean(detailBusy)}
          onClose={() => setDetail(null)}
          onRequest={(item) => void requestAlbum(item)}
        />
      )}

      {toast && <Toast message={toast.message} tone={toast.tone} />}
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone: "warn" | "bad" }) {
  const cls =
    tone === "bad"
      ? "border-red-400/30 bg-red-500/10 text-red-200"
      : "border-amber-400/20 bg-amber-500/5 text-amber-200/80";
  return (
    <div className={`mt-4 rounded-lg border px-4 py-2.5 text-sm ${cls}`} role="status">
      {children}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/10 bg-ink-900/40 px-5 py-10 text-center">
      <p className="text-sm font-medium text-white/70">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-white/40">{body}</p>
    </div>
  );
}

function ShelfSkeleton({ count }: { count: number }) {
  return (
    <ul className="flex gap-4 overflow-hidden pb-2 scrollbar-none" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="w-40 shrink-0 sm:w-44">
          <div className="aspect-square w-full animate-pulse-soft rounded-xl bg-ink-800" />
          <div className="mt-2.5 h-3.5 w-3/4 animate-pulse-soft rounded bg-ink-800" />
          <div className="mt-1.5 h-3 w-1/2 animate-pulse-soft rounded bg-ink-850" />
        </li>
      ))}
    </ul>
  );
}
