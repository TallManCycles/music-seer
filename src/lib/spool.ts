import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { RunOutcome } from "./types";

/**
 * The spool is how the app hands a yt-dlp job to a worker without either side
 * being able to run code for the other beyond "run yt-dlp with these argv".
 *
 * Files, per request id, all in the spool directory:
 *
 *   <id>.args     argv for yt-dlp, one element per line, trailing newline.
 *                 Written first (temp + rename), so a reader never sees a
 *                 partial file.
 *   <id>.job      empty marker. Its presence is what tells the worker there is
 *                 work; the worker claims it by renaming it to <id>.running,
 *                 which is atomic, so exactly one worker runs a given job.
 *   <id>.running  claim marker while the job is in flight.
 *   <id>.log      yt-dlp's combined output, appended live, so the app can show
 *                 progress and recover the produced file paths.
 *   <id>.status   written last (temp + rename): "ok" or "fail:<exit code>".
 *                 Its presence means the job is finished and the app may
 *                 finalize and clean up.
 *
 * Because the argv file is newline-delimited, `validateSource` refuses any
 * source containing control characters; that is what keeps the one field the
 * user controls from breaking the framing.
 */

function spoolDir(): string {
  return config().ytdlp.spoolPath;
}

function pathsFor(requestId: number) {
  const base = path.join(spoolDir(), String(requestId));
  return {
    base,
    args: `${base}.args`,
    job: `${base}.job`,
    running: `${base}.running`,
    log: `${base}.log`,
    status: `${base}.status`,
  };
}

/** Write atomically so a concurrent reader never sees a half-written file. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8" });
  fs.renameSync(tmp, file);
}

/**
 * Hand one job to the worker. Returns an error string when the job could not
 * be queued (bad spool directory is the realistic case).
 */
export function writeJob(requestId: number, args: string[]): { ok: true } | { ok: false; error: string } {
  if (args.length === 0) return { ok: false, error: "refusing to queue a job with no arguments" };
  const p = pathsFor(requestId);
  try {
    fs.mkdirSync(spoolDir(), { recursive: true });
    // Stale leftovers from a previous attempt would confuse the worker.
    for (const stale of [p.job, p.running, p.status, p.log]) {
      try {
        fs.rmSync(stale, { force: true });
      } catch {
        /* best effort */
      }
    }
    writeAtomic(p.args, `${args.join("\n")}\n`);
    writeAtomic(p.job, "");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Last meaningful line of the worker log, for progress reporting. */
export function jobProgress(requestId: number): string | undefined {
  const p = pathsFor(requestId);
  try {
    const lines = fs.readFileSync(p.log, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (line) return line.slice(0, 300);
    }
  } catch {
    /* no log yet */
  }
  return undefined;
}

/** How long a claimed-but-unfinished job may sit before we call it dead. */
const STALE_JOB_MS = 6 * 60 * 60 * 1000;

/**
 * Read a finished job, or null when it is still queued/running. The caller is
 * responsible for `clearJob` once the result has been written to the database.
 */
export function readJob(requestId: number): RunOutcome | null {
  const p = pathsFor(requestId);

  let status: string;
  try {
    status = fs.readFileSync(p.status, "utf8").trim();
  } catch {
    // No status yet: either not started, still running, or the worker died.
    let runningAgeMs = 0;
    try {
      runningAgeMs = Date.now() - fs.statSync(p.running).mtimeMs;
    } catch {
      return null; // never claimed (or never queued) — nothing to report
    }
    if (runningAgeMs < STALE_JOB_MS) return null;
    return {
      ok: false,
      skipped: false,
      files: [],
      error: `yt-dlp worker stopped responding (job claimed ${Math.round(runningAgeMs / 60_000)} min ago)`,
    };
  }

  const files = parseFileLines(readLog(requestId));
  if (status === "ok") {
    return { ok: true, skipped: false, files };
  }
  const code = status.startsWith("fail:") ? status.slice("fail:".length) : status;
  const tail = lastErrorLine(readLog(requestId));
  return {
    ok: false,
    skipped: false,
    files,
    error: tail || `yt-dlp exited with code ${code}`,
  };
}

/** True when a job has been queued for this request but not yet finalized. */
export function hasJob(requestId: number): boolean {
  const p = pathsFor(requestId);
  return [p.job, p.running].some((file) => fs.existsSync(file));
}

/** Remove every spool file belonging to a request. */
export function clearJob(requestId: number): void {
  const p = pathsFor(requestId);
  for (const file of [p.args, p.job, p.running, p.log, p.status]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Counts for the status page: queued (unclaimed) and running jobs. */
export function spoolDepth(): { jobsRunning: number; jobsQueued: number } {
  let jobsRunning = 0;
  let jobsQueued = 0;
  try {
    for (const entry of fs.readdirSync(spoolDir())) {
      if (entry.endsWith(".running")) jobsRunning += 1;
      else if (entry.endsWith(".job")) jobsQueued += 1;
    }
  } catch {
    /* spool does not exist yet */
  }
  return { jobsRunning, jobsQueued };
}

function readLog(requestId: number): string {
  try {
    return fs.readFileSync(pathsFor(requestId).log, "utf8");
  } catch {
    return "";
  }
}

/**
 * True for a line yt-dlp printed that names a file it produced. The worker
 * prints container paths ("/inbox/..."), mapped onto the host by toHostPath.
 * The host inbox path is also accepted, because a locally-run yt-dlp (or a
 * worker whose mounts use the host path) reports it that way instead.
 */
export function isFileLine(line: string): boolean {
  const y = config().ytdlp;
  const normal = line.trim().replace(/\\/g, "/");
  if (!normal) return false;
  const roots = [y.inboxContainerPath, y.configContainerPath];
  if (roots.some((root) => normal.startsWith(`${root}/`))) return true;
  const hostRoot = y.inboxHostPath.replace(/\\/g, "/");
  return Boolean(hostRoot) && normal.startsWith(`${hostRoot}/`);
}

/**
 * Map a path yt-dlp printed onto the host filesystem. Container paths
 * ("/inbox/...") become host paths; anything else is passed through.
 */
export function toHostPath(containerPath: string): string {
  const y = config().ytdlp;
  const inbox = y.inboxContainerPath.replace(/\/+$/, "");
  if (containerPath.startsWith(`${inbox}/`)) {
    // path.join keeps the separator style of whichever platform we are on.
    return path.join(y.inboxHostPath, containerPath.slice(inbox.length + 1));
  }
  const conf = y.configContainerPath.replace(/\/+$/, "");
  if (containerPath.startsWith(`${conf}/`)) {
    return path.join(y.configHostPath, containerPath.slice(conf.length + 1));
  }
  return containerPath;
}

export function parseFileLines(log: string): string[] {
  return log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => isFileLine(line))
    .map((line) => toHostPath(line));
}

function lastErrorLine(log: string): string | undefined {
  const lines = log.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (/^ERROR:|error:/i.test(line)) return line.slice(0, 300);
  }
  return undefined;
}
