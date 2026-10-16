"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CoverImage from "./CoverImage";
import StatusBadge from "./StatusBadge";
import type { MediaType, RequestStatus, SearchResult } from "@/lib/types";

type Hit = SearchResult & { requestId?: number; requestStatus?: RequestStatus };

const TABS: { type: MediaType; label: string; placeholder: string }[] = [
  { type: "album", label: "Albums", placeholder: "Album or artist — e.g. Random Access Memories" },
  { type: "artist", label: "Artists", placeholder: "Artist — e.g. Daft Punk" },
  { type: "track", label: "Tracks", placeholder: "Song — e.g. Get Lucky" },
];

export default function SearchView({ embedded = false }: { embedded?: boolean }) {
  const [type, setType] = useState<MediaType>("album");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, "busy" | "done" | "error">>({});
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const tab = TABS.find((t) => t.type === type)!;

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setError(null);
      return;
    }
    const handle = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${type}`, {
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "search failed");
        setHits(data.results ?? []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "search failed");
        }
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [query, type]);

  const request = useCallback(async (hit: Hit) => {
    const key = `${hit.type}:${hit.mbid}`;
    setPending((p) => ({ ...p, [key]: "busy" }));
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: hit.type,
          mbid: hit.mbid,
          title: hit.title,
          artist: hit.artist,
          artistMbid: hit.artistMbid,
          releaseGroupMbid: hit.releaseGroupMbid,
          year: hit.year,
          coverUrl: hit.coverUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "request failed");
      setPending((p) => ({ ...p, [key]: "done" }));
      setNotice(
        data.duplicate
          ? `"${hit.title}" is already requested.`
          : `Requested "${hit.title}" — it is being sent to Lidarr.`
      );
      setHits((prev) =>
        prev.map((h) =>
          h.mbid === hit.mbid && h.type === hit.type
            ? { ...h, requestId: data.request.id, requestStatus: data.request.status }
            : h
        )
      );
    } catch (err) {
      setPending((p) => ({ ...p, [key]: "error" }));
      setNotice(err instanceof Error ? err.message : "request failed");
    }
  }, []);

  return (
    <div>
      {!embedded && (
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Discover</h1>
          <p className="mt-1 text-sm text-white/50">
            Search MusicBrainz. Requests go to Lidarr first; anything Lidarr cannot deliver is
            handed to yt-dlp automatically.
          </p>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-ink-900 p-1 ring-1 ring-white/5">
        {TABS.map((t) => (
          <button
            key={t.type}
            onClick={() => {
              setType(t.type);
              setNotice(null);
            }}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              t.type === type ? "bg-white/10 text-white" : "text-white/55 hover:text-white/90"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={tab.placeholder}
        className="w-full rounded-lg border border-white/10 bg-ink-900 px-4 py-3 text-[15px] outline-none placeholder:text-white/30 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
        autoFocus={!embedded}
      />

      {notice && (
        <div className="mt-3 rounded-lg border border-white/10 bg-ink-900 px-4 py-2.5 text-sm text-white/75">
          {notice}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && <p className="mt-4 text-sm text-white/40">Searching MusicBrainz…</p>}

      <ul className="mt-4 space-y-2">
        {hits.map((hit) => {
          const key = `${hit.type}:${hit.mbid}`;
          const state = pending[key];
          const done = state === "done" || Boolean(hit.requestId);
          return (
            <li
              key={key}
              className="flex items-center gap-4 rounded-xl border border-white/5 bg-ink-900/60 p-3 transition hover:border-white/10 hover:bg-ink-900"
            >
              <CoverImage
                mbid={hit.releaseGroupMbid ?? (hit.type === "album" ? hit.mbid : undefined)}
                alt={hit.title}
                size={100}
                className="h-14 w-14 shrink-0 rounded-lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{hit.title}</p>
                <p className="truncate text-sm text-white/50">
                  {[hit.artist, hit.year, hit.subtitle].filter(Boolean).join(" · ")}
                </p>
              </div>
              {hit.requestStatus && <StatusBadge status={hit.requestStatus} />}
              <button
                disabled={done || state === "busy"}
                onClick={() => request(hit)}
                className="shrink-0 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-white/40"
              >
                {done ? "Requested" : state === "busy" ? "Requesting…" : "Request"}
              </button>
            </li>
          );
        })}
      </ul>

      {!loading && query.trim().length >= 2 && hits.length === 0 && !error && (
        <p className="mt-6 text-center text-sm text-white/40">
          No matches in MusicBrainz for “{query.trim()}”.
        </p>
      )}
    </div>
  );
}
