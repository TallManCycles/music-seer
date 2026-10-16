import { spawn } from "node:child_process";
import { config } from "./config";
import { addEvent, updateRequest } from "./db";
import type { MediaType, MediaRequest } from "./types";

export interface RunOutcome {
  ok: boolean;
  files: string[];
  error?: string;
  skipped: boolean;
}

// --- command construction --------------------------------------------------

/**
 * Where yt-dlp should look. Tracks use a YouTube search (accounting for the
 * `ytsearchN:` prefix); albums and playlists are expected to be given as a
 * real URL by the user, but a search query is a reasonable default.
 */
export function defaultSourceFor(type: MediaType, artist: string, title: string): string {
  const a = artist.trim();
  const t = title.trim();
  if (type === "track") return `ytsearch1:${a} ${t}`.trim();
  if (type === "album") return `ytsearch1:${a} ${t} full album`.trim();
  return `ytsearch1:${a} greatest hits`.trim();
}

/**
 * Args passed to yt-dlp *inside* the container. Paths here are container
 * paths; the driver rewrites them for local runs.
 */
export function buildYtdlpArgs(source: string): string[] {
  const y = config().ytdlp;
  const args: string[] = [
    source,
    "--download-archive",
    `${y.configContainerPath}/${y.archive}`,
    "--ignore-errors",
    "--sleep-requests",
    "1",
    "--sleep-interval",
    "3",
    "--extract-audio",
    "--audio-format",
    "m4a",
    "--embed-metadata",
    "--embed-thumbnail",
    "--parse-metadata",
    "title:(?P<t_artist>.+?) [-–—] (?P<t_title>.+)",
    "--parse-metadata",
    "%(artist,t_artist,uploader)s:%(meta_artist)s",
    "--parse-metadata",
    "%(track,t_title,title)s:%(meta_title)s",
    "--replace-in-metadata",
    "meta_artist",
    " - Topic$",
    "",
    "--replace-in-metadata",
    "meta_title",
    String.raw`\s*[\(\[][^\)\]]*(Official|Lyric|Audio|Video|Visuali[sz]er|Clean|Free Download)[^\)\]]*[\)\]]`,
    "",
    "--output",
    `${y.inboxContainerPath}/%(meta_artist)s - %(meta_title)s [%(id)s].%(ext)s`,
    // Machine-readable bits we parse back out.
    "--print",
    "after_move:filepath",
    "--newline",
  ];

  if (source.startsWith("ytsearch:")) {
    args.push("--no-playlist");
  }
  args.push(...y.extraArgs);
  return args;
}

/** Rewrite container paths to host paths when running yt-dlp directly. */
function forLocalDriver(args: string[]): string[] {
  const y = config().ytdlp;
  return args.map((arg) =>
    arg
      .split(y.configContainerPath)
      .join(y.configHostPath)
      .split(y.inboxContainerPath)
      .join(y.inboxHostPath)
      .replace(/^\/inbox\//, `${y.inboxHostPath}/`)
  );
}

export function commandFor(source: string): { cmd: string; args: string[] } {
  const y = config().ytdlp;
  if (y.driver === "local") {
    return { cmd: "yt-dlp", args: forLocalDriver(buildYtdlpArgs(source)) };
  }
  // docker driver: mount the host inbox/config into the container.
  const args = [
    "run",
    "--rm",
    "-v",
    `${y.inboxHostPath}:${y.inboxContainerPath}`,
    "-v",
    `${y.configHostPath}:${y.configContainerPath}`,
    y.image,
    ...buildYtdlpArgs(source),
  ];
  return { cmd: "docker", args };
}

/** Map a container path from yt-dlp output onto the host filesystem. */
export function toHostPath(containerPath: string): string {
  const y = config().ytdlp;
  if (containerPath.startsWith(`${y.inboxContainerPath}/`)) {
    return y.inboxHostPath + containerPath.slice(y.inboxContainerPath.length);
  }
  if (containerPath.startsWith(`${y.configContainerPath}/`)) {
    return y.configHostPath + containerPath.slice(y.configContainerPath.length);
  }
  if (y.driver === "local") return containerPath;
  return containerPath;
}

// --- execution -------------------------------------------------------------

const FILE_LINE = /^\/(?:inbox|config)\/.+$/;

export function runYtdlp(
  source: string,
  opts: { onOutput?: (line: string) => void } = {}
): Promise<RunOutcome> {
  const { cmd, args } = commandFor(source);
  if (config().ytdlp.driver === "none") {
    return Promise.resolve({
      ok: false,
      skipped: true,
      files: [],
      error: "yt-dlp downloads are disabled (MUSICSEER_YTDLP_DRIVER=none)",
    });
  }

  return new Promise<RunOutcome>((resolve) => {
    const files: string[] = [];
    let stderrTail = "";
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(/* turbopackIgnore: true */ cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({
        ok: false,
        skipped: false,
        files: [],
        error: `could not start ${cmd}: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const handleLine = (line: string, isErr: boolean) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      if (FILE_LINE.test(trimmed)) {
        files.push(toHostPath(trimmed));
      } else if (isErr) {
        stderrTail = `${stderrTail}\n${trimmed}`.slice(-2000);
      }
      opts.onOutput?.(trimmed);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => chunk.split("\n").forEach((l) => handleLine(l, false)));
    child.stderr?.on("data", (chunk: string) => chunk.split("\n").forEach((l) => handleLine(l, true)));

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        skipped: false,
        files,
        error:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `executable not found: ${cmd}. Is Docker (or yt-dlp) installed and on PATH?`
            : err.message,
      });
    });

    child.on("close", (code) => {
      const ok = code === 0 || files.length > 0;
      finish({
        ok,
        skipped: false,
        files,
        error: ok ? undefined : (stderrTail.trim() || `yt-dlp exited with code ${code}`),
      });
    });
  });
}

// --- serialized queue ------------------------------------------------------

let running = 0;
const pending: MediaRequest[] = [];
const MAX_CONCURRENT = 1;

export function queueDepth(): { jobsRunning: number; jobsQueued: number } {
  return { jobsRunning: running, jobsQueued: pending.length };
}

export function enqueueFallback(request: MediaRequest): void {
  if (pending.some((r) => r.id === request.id)) return;
  pending.push(request);
  void pump();
}

async function pump(): Promise<void> {
  while (running < MAX_CONCURRENT && pending.length > 0) {
    const req = pending.shift()!;
    running += 1;
    void runFallback(req).finally(() => {
      running -= 1;
      void pump();
    });
  }
}

/** Runs one fallback job and writes the outcome back to the database. */
export async function runFallback(request: MediaRequest): Promise<RunOutcome> {
  const source =
    request.ytdlpSource ??
    defaultSourceFor(request.type, request.artist, request.title);

  updateRequest(request.id, {
    source: "ytdlp",
    status: "downloading",
    statusDetail: `yt-dlp: ${source}`,
    fallbackAt: request.fallbackAt ?? new Date().toISOString(),
    attempts: request.attempts + 1,
  });
  addEvent(request.id, "info", `yt-dlp started for ${source}`);

  const outcome = await runYtdlp(source, {
    onOutput: (line) => {
      if (/^\[download\]\s+\d|\bDestination:/.test(line)) {
        updateRequest(request.id, { statusDetail: line.slice(0, 300) });
      }
    },
  });

  const merged = Array.from(new Set([...(request.files ?? []), ...outcome.files]));

  if (outcome.ok && merged.length > 0) {
    updateRequest(request.id, {
      status: "import_pending",
      statusDetail: `${merged.length} file(s) downloaded to the inbox`,
      files: merged,
      lastError: null,
      completedAt: new Date().toISOString(),
    });
    addEvent(request.id, "info", `yt-dlp finished: ${merged.length} file(s) in the inbox`);
  } else if (outcome.ok) {
    // Exit 0 with no new files usually means the archive already had it.
    updateRequest(request.id, {
      status: outcome.skipped ? "failed" : "import_pending",
      statusDetail: outcome.skipped
        ? outcome.error
        : "already in the download archive (nothing new fetched)",
      lastError: outcome.skipped ? (outcome.error ?? null) : null,
      completedAt: new Date().toISOString(),
    });
    addEvent(request.id, outcome.skipped ? "warn" : "info", outcome.error ?? "no new files downloaded");
  } else {
    updateRequest(request.id, {
      status: "failed",
      statusDetail: "yt-dlp failed",
      lastError: outcome.error ?? "unknown error",
    });
    addEvent(request.id, "error", outcome.error ?? "yt-dlp failed");
  }

  return outcome;
}
