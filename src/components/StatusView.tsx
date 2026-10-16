"use client";

import { useCallback, useEffect, useState } from "react";

interface Health {
  scheduler: {
    running: boolean;
    intervalMinutes: number;
    lastTick?: string;
    lastError?: string;
    jobsRunning: number;
    jobsQueued: number;
  };
  lidarr: { configured: boolean; ok: boolean; version?: string; error?: string };
  ytdlp: { driver: string; image: string; inbox: string; spool: string; archive: string; sampleCommand: string };
  policy: { fallbackAfterMinutes: number; pollIntervalMinutes: number; completeThreshold: number };
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-ok" : "bg-bad"}`}
      aria-hidden
    />
  );
}

export default function StatusView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tick = false) => {
    try {
      const res = await fetch(`/api/health${tick ? "?tick=1" : ""}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not load health");
      setHealth(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load health");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {error}
      </div>
    );
  }
  if (!health) return <p className="text-sm text-white/40">Checking…</p>;

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
          <p className="mt-1 text-sm text-white/50">
            Where requests go, and whether the machinery is healthy.
          </p>
        </div>
        <button
          onClick={() => void load(true)}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5"
        >
          Run reconciliation now
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-white/45">
            <Dot ok={health.lidarr.ok} /> Lidarr
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="Configured" value={health.lidarr.configured ? "yes" : "no"} />
            <Row label="Reachable" value={health.lidarr.ok ? "yes" : "no"} />
            {health.lidarr.version && <Row label="Version" value={health.lidarr.version} />}
            {health.lidarr.error && <Row label="Error" value={health.lidarr.error} bad />}
          </dl>
        </section>

        <section className="rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-white/45">
            <Dot ok={health.ytdlp.driver !== "none"} /> yt-dlp fallback
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="Driver" value={health.ytdlp.driver} />
            <Row label="Worker image" value={health.ytdlp.image} />
            <Row label="Inbox (worker)" value={health.ytdlp.inbox} />
            <Row label="Spool" value={health.ytdlp.spool} />
            <Row label="Archive" value={health.ytdlp.archive} />
          </dl>
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-ink-950 p-3 font-mono text-[11px] leading-relaxed text-white/60">
            {health.ytdlp.sampleCommand}
          </pre>
        </section>

        <section className="rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-white/45">
            <Dot ok={health.scheduler.running} /> Scheduler
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row label="Running" value={health.scheduler.running ? "yes" : "no"} />
            <Row label="Interval" value={`${health.scheduler.intervalMinutes} min`} />
            <Row
              label="Last tick"
              value={
                health.scheduler.lastTick
                  ? new Date(health.scheduler.lastTick).toLocaleTimeString()
                  : "not yet"
              }
            />
            <Row label="yt-dlp jobs" value={`${health.scheduler.jobsRunning} running, ${health.scheduler.jobsQueued} waiting`} />
            {health.scheduler.lastError && (
              <Row label="Last error" value={health.scheduler.lastError} bad />
            )}
          </dl>
        </section>

        <section className="rounded-xl border border-white/5 bg-ink-900/60 p-4">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-white/45">
            Fallback policy
          </h2>
          <dl className="space-y-1.5 text-sm">
            <Row
              label="Wait before fallback"
              value={
                health.policy.fallbackAfterMinutes > 0
                  ? `${health.policy.fallbackAfterMinutes} min`
                  : "manual only"
              }
            />
            <Row label="Poll interval" value={`${health.policy.pollIntervalMinutes} min`} />
            <Row
              label="Album complete at"
              value={`${Math.round(health.policy.completeThreshold * 100)}% of tracks`}
            />
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-white/40">
            Files land in the inbox, not the library. Run Lidarr&apos;s{" "}
            <span className="font-mono">DownloadedAlbumsScan</span> (or your own import step) to move
            them into place.
          </p>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-40 shrink-0 text-white/45">{label}</dt>
      <dd className={`min-w-0 break-words ${bad ? "text-red-300/90" : "text-white/80"}`}>
        {value}
      </dd>
    </div>
  );
}
