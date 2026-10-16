import { config } from "./config";
import * as db from "./db";
import { reconcile, isTerminal } from "./requests";
import { enqueueFallback, queueDepth } from "./ytdlp";

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
  const stranded = db.listByStatus(["fallback_queued", "downloading"]);
  for (const request of stranded) {
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
    const active = db
      .listRequests()
      .filter((r) => !isTerminal(r.status) && r.source === "lidarr");
    for (const request of active) {
      const fresh = db.getRequest(request.id);
      if (fresh && !isTerminal(fresh.status)) await reconcile(fresh);
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
