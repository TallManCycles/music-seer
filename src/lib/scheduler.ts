import { config } from "./config";
import * as db from "./db";
import { scanArtists } from "./discover";
import { reconcile, isTerminal } from "./requests";
import { enqueueFallback, queueDepth } from "./ytdlp";
import * as spool from "./spool";
import type { RequestStatus } from "./types";

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  lastTick?: string;
  lastError?: string;
  ticking: boolean;
}

// Survive Next.js hot reloads in dev by parking state on globalThis.
const globalRef = globalThis as unknown as { __musicSeerScheduler?: SchedulerState };

function state(): SchedulerState {
  if (!globalRef.__musicSeerScheduler) {
    globalRef.__musicSeerScheduler = { timer: null, ticking: false };
  }
  return globalRef.__musicSeerScheduler;
}

export function schedulerInfo() {
  const s = state();
  return {
    running: s.timer !== null,
    intervalMinutes: config().pollIntervalMinutes,
    lastTick: s.lastTick,
    lastError: s.lastError,
    ...queueDepth(),
  };
}

/** Re-arm jobs that were mid-flight when the process last exited. */
function recover(): void {
  // With the queue driver a job outlives this process: the worker owns it and
  // the spool file is still there, so only re-queue what was never handed over.
  const statuses: RequestStatus[] =
    config().ytdlp.driver === "queue" ? ["fallback_queued"] : ["fallback_queued", "downloading"];

  for (const request of db.listByStatus(statuses)) {
    if (spool.hasJob(request.id)) continue;
    db.addEvent(request.id, "warn", "Re-queuing job after restart");
    db.updateRequest(request.id, { status: "fallback_queued" });
    enqueueFallback({ ...request, status: "fallback_queued" });
  }
}

export async function tick(): Promise<void> {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  try {
    // reconcile() decides what each request needs: Lidarr polling for
    // lidarr-sourced requests, queue polling for yt-dlp ones.
    const active = db.listRequests().filter((r) => !isTerminal(r.status));
    for (const request of active) {
      const fresh = db.getRequest(request.id);
      if (fresh && !isTerminal(fresh.status)) await reconcile(fresh);
    }

    // Keep the discovery pool warm: a few artists per tick, so GET /api/discover
    // only ever reads it. Wrapped so a scan failure cannot break reconciliation.
    try {
      await scanArtists(3);
    } catch (err) {
      console.error("[music-seer] discover scan hook failed:", err);
    }

    s.lastTick = new Date().toISOString();
    s.lastError = undefined;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    s.ticking = false;
  }
}

export function start(): void {
  const s = state();
  if (s.timer) return;
  recover();
  const intervalMs = Math.max(1, config().pollIntervalMinutes) * 60_000;
  s.timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open because of the scheduler.
  s.timer.unref?.();
  void tick();
}

export function stop(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}
