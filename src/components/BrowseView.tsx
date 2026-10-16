"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import SearchView from "./SearchView";
import AlbumTile from "./AlbumTile";
import AlbumDetailModal, { type AlbumDetailItem } from "./AlbumDetailModal";
import StatusBadge from "./StatusBadge";
import Toast from "./Toast";
import type { RequestStatus } from "@/lib/types";

interface LibraryAlbum {
  id: string;
  title: string;
  artist: string;
  year?: string;
  hasArt: boolean;
  coverUrl: string;
  artistMbid?: string;
}

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

interface LibraryPayload {
  configured: boolean;
  total: number;
  needsSetup?: boolean;
  albums: LibraryAlbum[];
  error?: string;
}

interface DiscoverPayload {
  configured: boolean;
  libraryAlbums: number;
  libraryArtists: number;
  suggestions: Suggestion[];
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

function suggestionCover(album: DiscoverAlbum): string {
  const mbid = album.releaseGroupMbid ?? album.mbid;
  return `/api/cover?mbid=${mbid}&size=300`;
}

export default function BrowseView() {
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
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
        const res = await fetch("/api/library?limit=200", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data: LibraryPayload = await res.json();
        if (!res.ok) throw new Error(data.error ?? "could not load your library");
        setLibrary(data);
        setLibraryError(data.error ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setLibraryError(err instanceof Error ? err.message : "could not load your library");
      }
    })();
    return () => ctrl.abort();
  }, []);

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

  const openLibrary = useCallback((album: LibraryAlbum) => {
    setDetail({
      type: "album",
      mbid: album.id,
      title: album.title,
      artist: album.artist,
      year: album.year,
      artistMbid: album.artistMbid,
      coverSrc: album.coverUrl,
      inLibrary: true,
    });
  }, []);

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

  const needsSetup = useMemo(
    () =>
      Boolean(
        library?.needsSetup ||
          library?.configured === false ||
          discover?.configured === false
      ),
    [library, discover]
  );

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
        {(library || discover) && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/45">
            {library && <span>{library.total} albums in your library</span>}
            {discover && <span>{discover.libraryArtists} artists</span>}
            {discover && discover.suggestions.length > 0 && (
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

      {libraryError && (
        <Notice tone="warn">Your library could not be read: {libraryError}</Notice>
      )}

      {!needsSetup && (
        <section className="mt-10">
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Your library</h2>
              <p className="mt-0.5 text-sm text-white/45">
                Everything Jellyfin can see, newest first.
              </p>
            </div>
            {library && <span className="text-xs text-white/40">{library.total} albums</span>}
          </header>

          {!library ? (
            <AlbumGridSkeleton count={12} />
          ) : library.albums.length === 0 ? (
            <EmptyState
              title="Your library is empty"
              body="Once Jellyfin has albums, they will show up here as a grid."
            />
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {library.albums.map((album) => (
                <li key={album.id}>
                  <AlbumTile
                    title={album.title}
                    artist={album.artist}
                    year={album.year}
                    coverSrc={album.hasArt ? album.coverUrl : undefined}
                    onOpen={() => openLibrary(album)}
                  />
                </li>
              ))}
            </ul>
          )}
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

      <section className="mt-12">
        <header className="mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Search MusicBrainz</h2>
          <p className="mt-0.5 text-sm text-white/45">
            Looking for something specific? Search and request it directly.
          </p>
        </header>
        <SearchView embedded />
      </section>

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

function AlbumGridSkeleton({ count }: { count: number }) {
  return (
    <ul
      className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
      aria-hidden
    >
      {Array.from({ length: count }).map((_, i) => (
        <li key={i}>
          <div className="aspect-square w-full animate-pulse-soft rounded-xl bg-ink-800" />
          <div className="mt-2.5 h-3.5 w-3/4 animate-pulse-soft rounded bg-ink-800" />
          <div className="mt-1.5 h-3 w-1/2 animate-pulse-soft rounded bg-ink-850" />
        </li>
      ))}
    </ul>
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
