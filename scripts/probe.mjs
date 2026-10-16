#!/usr/bin/env node
/**
 * Quick sanity probe: asks a running music-seer for its health, prints a
 * summary, and exits non-zero if Lidarr is unreachable.
 *
 *   node scripts/probe.mjs          # plain check
 *   node scripts/probe.mjs --tick   # trigger a reconciliation first
 */
const base =
  process.env.MUSICSEER_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8666}`;
const tick = process.argv.includes("--tick");

const res = await fetch(`${base}/api/health${tick ? "?tick=1" : ""}`);
if (!res.ok) {
  console.error(`health request failed: HTTP ${res.status}`);
  process.exit(2);
}
const h = await res.json();

const line = (k, v) => console.log(`${k.padEnd(22)} ${v}`);
console.log("music-seer probe");
line("scheduler running", h.scheduler.running);
line("poll interval", `${h.scheduler.intervalMinutes} min`);
line("last tick", h.scheduler.lastTick ?? "never");
line("yt-dlp jobs", `${h.scheduler.jobsRunning} running, ${h.scheduler.jobsQueued} waiting`);
console.log("");
line("lidarr configured", h.lidarr.configured);
line("lidarr reachable", h.lidarr.ok);
if (h.lidarr.version) line("lidarr version", h.lidarr.version);
if (h.lidarr.error) line("lidarr error", h.lidarr.error);
console.log("");
line("yt-dlp driver", h.ytdlp.driver);
line("inbox", h.ytdlp.inbox);
console.log("\nsample yt-dlp command:\n" + h.ytdlp.sampleCommand);

process.exit(h.lidarr.ok ? 0 : 1);
