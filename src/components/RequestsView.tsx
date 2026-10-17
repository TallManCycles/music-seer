"use client";

import { useCallback, useEffect, useState } from "react";
import CoverImage from "./CoverImage";
import StatusBadge from "./StatusBadge";
import { formatRelative, isActive } from "@/lib/status";
import type { MediaRequest, RequestEvent, RequestStatus } from "@/lib/types";

type Filter = "active" | "all" | "available" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "available", label: "Available" },
  { id: "failed", label: "Failed" },
  { id: "all", label: "All" },
];

const TYPE_LABEL: Record<string, string> = { artist: "Artist", album: "Album", track: "Track" };

function matchesFilter(r: MediaRequest, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActive(r.status);
  if (filter === "available") return r.status === "available";
  return r.status === "failed" || r.status === "cancelled";
}

export default function RequestsView({ initialFilter = "active" }: { initialFilter?: Filter }) {
  const [requests, setRequests] = useState<MediaRequest[]>([]);
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [events, setEvents] = useState<Record<number, RequestEvent[]>>({});
  const [sourceDraft, setSourceDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/requests", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not load requests");
      setRequests(data.requests ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load requests");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const call = useCallback(
    async (id: number, fn: () => Promise<Response>) => {
      setBusy(id);
      try {
        const res = await fn();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "action failed");
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "action failed");
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const toggleDetails = useCallback(
    async (id: number) => {
      if (expanded === id) {
        setExpanded(null);
        return;
      }
      setExpanded(id);
      const res = await fetch(`/api/requests/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setEvents((e) => ({ ...e, [id]: data.events ?? [] }));
    },
    [expanded]
  );

  const visible = requests.filter((r) => matchesFilter(r, filter));
  const counts = {
    active: requests.filter((r) => isActive(r.status)).length,
    available: requests.filter((r) => r.status === "available").length,
    failed: requests.filter((r) => r.status === "failed" || r.status === "cancelled").length,
    all: requests.length,
  } as Record<Filter, number>;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
          <p className="mt-1 text-sm text-white/50">
            Auto-refreshing every 5 seconds. {counts.active} in flight.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-ink-900 p-1 ring-1 ring-white/5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              filter === f.id ? "bg-white/10 text-white" : "text-white/55 hover:text-white/90"
            }`}
          >
            {f.label}
            <span className="ml-1.5 text-white/35">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-white/40">Loading…</p>}
      {!loading && visible.length === 0 && (
        <p className="py-12 text-center text-sm text-white/40">
          Nothing here yet. Head to Discover and request something.
        </p>
      )}

      <ul className="space-y-3">
        {visible.map((r) => {
          const isBusy = busy === r.id;
          const draft = sourceDraft[r.id] ?? r.ytdlpSource ?? "";
          return (
            <li
              key={r.id}
              className="rounded-xl border border-white/5 bg-ink-900/60 p-4 transition hover:border-white/10"
            >
              <div className="flex items-start gap-4">
                <CoverImage
                  mbid={r.releaseGroupMbid ?? (r.type === "album" ? r.mbid : undefined)}
                  alt={r.title}
                  size={100}
                  className="h-16 w-16 shrink-0 rounded-lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.title}</span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-white/45">
                      {TYPE_LABEL[r.type] ?? r.type}
                    </span>
                    <StatusBadge status={r.status as RequestStatus} />
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${
                        r.source === "ytdlp"
                          ? "bg-amber-500/10 text-amber-300/80"
                          : "bg-indigo-500/10 text-indigo-300/80"
                      }`}
                    >
                      {r.source === "ytdlp" ? "yt-dlp" : "Lidarr"}
                    </span>
                    {!r.autoFallback && (
                      <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-white/40">
                        auto-fallback off
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-white/50">
                    {[r.artist, r.year].filter(Boolean).join(" · ")}
                  </p>
                  {r.statusDetail && (
                    <p className="mt-1 line-clamp-2 break-words text-sm text-white/60">
                      {r.statusDetail}
                    </p>
                  )}
                  {r.lastError && (
                    <p className="mt-1 break-words text-sm text-red-300/80">{r.lastError}</p>
                  )}
                  <p className="mt-1.5 text-xs text-white/35">
                    requested {formatRelative(r.requestedAt)}
                    {r.submittedAt && ` · lidarr ${formatRelative(r.submittedAt)}`}
                    {r.fallbackAt && ` · fallback ${formatRelative(r.fallbackAt)}`}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                <button
                  disabled={isBusy}
                  onClick={() =>
                    call(r.id, () =>
                      fetch(`/api/requests/${r.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "refresh" }),
                      })
                    )
                  }
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5 disabled:opacity-40"
                >
                  Check now
                </button>

                <button
                  disabled={isBusy}
                  onClick={() =>
                    call(r.id, () =>
                      fetch(`/api/requests/${r.id}/fallback`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(draft ? { source: draft } : {}),
                      })
                    )
                  }
                  className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-200 ring-1 ring-inset ring-amber-400/25 transition hover:bg-amber-500/25 disabled:opacity-40"
                >
                  ✦ Get via yt-dlp
                </button>

                {(r.status === "import_pending" || r.files.length > 0) && (
                  <button
                    disabled={isBusy}
                    title="Asks Jellyfin to rescan its libraries, and Lidarr too if it is configured. Use this after your importer has moved the files out of the inbox."
                    onClick={() =>
                      call(r.id, () => fetch(`/api/requests/${r.id}/import`, { method: "POST" }))
                    }
                    className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 transition hover:bg-emerald-500/20 disabled:opacity-40"
                  >
                    Rescan library
                  </button>
                )}

                {(r.status === "failed" || r.status === "cancelled") && (
                  <button
                    disabled={isBusy}
                    onClick={() =>
                      call(r.id, () =>
                        fetch(`/api/requests/${r.id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "resubmit" }),
                        })
                      )
                    }
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5 disabled:opacity-40"
                  >
                    Retry via Lidarr
                  </button>
                )}

                <button
                  onClick={() => void toggleDetails(r.id)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5"
                >
                  {expanded === r.id ? "Hide log" : "Log"}
                </button>

                {isActive(r.status as RequestStatus) && (
                  <button
                    disabled={isBusy}
                    onClick={() =>
                      call(r.id, () => fetch(`/api/requests/${r.id}`, { method: "DELETE" }))
                    }
                    className="ml-auto rounded-lg px-3 py-1.5 text-sm text-red-300/80 transition hover:bg-red-500/10 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {(expanded === r.id || r.status === "fallback_queued") && (
                <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
                  <label className="block">
                    <span className="text-xs uppercase tracking-wide text-white/40">
                      yt-dlp source (a YouTube Music URL, or a{" "}
                      <code className="text-white/60">ytsearch1:</code> query)
                    </span>
                    <div className="mt-1 flex gap-2">
                      <input
                        value={draft}
                        onChange={(e) => setSourceDraft((s) => ({ ...s, [r.id]: e.target.value }))}
                        placeholder="https://music.youtube.com/playlist?list=…"
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950 px-3 py-2 font-mono text-xs outline-none placeholder:text-white/25 focus:border-accent/60"
                      />
                      <button
                        disabled={isBusy}
                        onClick={() =>
                          call(r.id, () =>
                            fetch(`/api/requests/${r.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ ytdlpSource: draft }),
                            })
                          )
                        }
                        className="rounded-lg border border-white/10 px-3 py-2 text-xs text-white/70 transition hover:bg-white/5 disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </label>

                  {expanded === r.id && (
                    <ul className="space-y-1">
                      {(events[r.id] ?? []).map((e) => (
                        <li key={e.id} className="flex gap-3 font-mono text-xs">
                          <span className="shrink-0 text-white/30">
                            {new Date(e.at).toLocaleTimeString()}
                          </span>
                          <span
                            className={
                              e.level === "error"
                                ? "text-red-300/90"
                                : e.level === "warn"
                                  ? "text-amber-300/90"
                                  : "text-white/60"
                            }
                          >
                            {e.message}
                          </span>
                        </li>
                      ))}
                      {(events[r.id] ?? []).length === 0 && (
                        <li className="text-xs text-white/30">No events recorded.</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
