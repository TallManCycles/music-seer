"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AlbumTile from "./AlbumTile";
import AlbumDetailModal, { type AlbumDetailItem } from "./AlbumDetailModal";

interface LibraryAlbum {
  id: string;
  title: string;
  artist: string;
  year?: string;
  hasArt: boolean;
  coverUrl: string;
  artistMbid?: string;
}

interface LibraryPayload {
  configured: boolean;
  total: number;
  needsSetup?: boolean;
  albums: LibraryAlbum[];
  error?: string;
}

/** How many albums to render at once; "Load more" reveals another batch. */
const PAGE_SIZE = 60;

export default function LibraryView() {
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<AlbumDetailItem | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/library?limit=1000", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const data: LibraryPayload = await res.json();
        if (!res.ok) throw new Error(data.error ?? "could not load your library");
        setLibrary(data);
        setError(data.error ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "could not load your library");
      }
    })();
    return () => ctrl.abort();
  }, []);

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

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? (library?.albums ?? []).filter(
        (album) =>
          album.title.toLowerCase().includes(needle) ||
          album.artist.toLowerCase().includes(needle)
      )
    : library?.albums ?? [];

  const needsSetup = Boolean(library?.needsSetup || library?.configured === false);
  const shown = Math.min(visible, filtered.length);

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Your library</h1>
        <p className="mt-1 text-sm text-white/50">
          {library
            ? `${library.total} album${library.total === 1 ? "" : "s"} Jellyfin can see, newest first.`
            : "Everything Jellyfin can see, newest first."}
        </p>
      </header>

      {needsSetup && (
        <section className="mb-8 rounded-xl border border-accent/20 bg-accent/10 p-5">
          <h2 className="text-base font-semibold">Connect Jellyfin to browse your library</h2>
          <p className="mt-1 text-sm text-white/60">
            The library is built from what Jellyfin can see. Add your server and credentials to get
            started.
          </p>
          <Link
            href="/settings"
            className="mt-3 inline-block rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 motion-reduce:transition-none"
          >
            Open settings
          </Link>
        </section>
      )}

      {error && <Notice>Your library could not be read: {error}</Notice>}

      {!needsSetup && (
        <section>
          {!library ? (
            <AlbumGridSkeleton count={12} />
          ) : library.albums.length === 0 ? (
            <EmptyState
              title="Your library is empty"
              body="Once Jellyfin has albums, they will show up here as a grid."
            />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setVisible(PAGE_SIZE);
                  }}
                  placeholder="Filter by album or artist"
                  aria-label="Filter your library by album or artist"
                  className="w-full max-w-sm rounded-lg border border-white/10 bg-ink-900 px-4 py-2.5 text-sm outline-none placeholder:text-white/30 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
                />
                <span className="text-xs text-white/40">
                  {needle
                    ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}`
                    : `Showing ${shown} of ${filtered.length}`}
                </span>
              </div>

              {filtered.length === 0 ? (
                <EmptyState
                  title="No matches"
                  body={`Nothing in your library matches “${query.trim()}”.`}
                />
              ) : (
                <>
                  <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {filtered.slice(0, visible).map((album) => (
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
                  {shown < filtered.length && (
                    <div className="mt-6 flex flex-col items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setVisible((v) => v + PAGE_SIZE)}
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/85 transition hover:border-white/20 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 motion-reduce:transition-none"
                      >
                        Load more
                      </button>
                      <span className="text-xs text-white/40">
                        Showing {shown} of {filtered.length}
                      </span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      {detail && (
        <AlbumDetailModal
          item={detail}
          onClose={() => setDetail(null)}
          onRequest={() => {}}
        />
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-4 rounded-lg border border-amber-400/20 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200/80"
      role="status"
    >
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
