import { spawn } from "node:child_process";
import { config } from "./config";
import { addEvent, updateRequest } from "./db";
import * as spool from "./spool";
import { toHostPath } from "./spool";
import type { MediaType, MediaRequest, RunOutcome } from "./types";

export type { RunOutcome };

// --- source validation -----------------------------------------------------

const MAX_SOURCE_LENGTH = 2000;
const SEARCH_PREFIX = /^ytsearch(\d*):(.*)$/i;
const HTTP_URL = /^https?:\/\/\S+$/i;
// Anything that could act as an option, split the newline-delimited argv file
// the worker reads, or smuggle a second argv element.
const FORBIDDEN = /[\u0000-\u001f\u007f]/;

export type SourceCheck = { ok: true; source: string } | { ok: false; reason: string };

/**
 * The only field a user controls that ends up in yt-dlp's argv. It must be a
 * plain http(s) URL or a `ytsearch[N]:` query — never a bare option, another
 * scheme (`file:`, `--config-locations`, ...), or anything with control
 * characters. Everything else is rejected outright rather than escaped,
 * because escaping argv is exactly the kind of thing that goes wrong quietly.
 */
export function validateSource(raw: unknown): SourceCheck {
  if (typeof raw !== "string") return { ok: false, reason: "source must be a string" };
  const source = raw.trim();
  if (!source) return { ok: false, reason: "source is empty" };
  if (source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `source is longer than ${MAX_SOURCE_LENGTH} characters` };
  }
  if (FORBIDDEN.test(source)) {
    return { ok: false, reason: "source contains control characters" };
  }
  if (source.startsWith("-")) {
    return { ok: false, reason: "source must not start with '-'" };
  }

  const search = SEARCH_PREFIX.exec(source);
  if (search) {
    const query = search[2].trim();
    if (!query) return { ok: false, reason: "ytsearch: needs a query" };
    const n = search[1] === "" ? 1 : Number(search[1]);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      return { ok: false, reason: "ytsearch: result count must be between 1 and 50" };
    }
    return { ok: true, source: source.replace(/\s+/g, " ") };
  }

  if (HTTP_URL.test(source)) return { ok: true, source };
  return {
    ok: false,
    reason: "source must be an http(s) URL or a ytsearch: query (e.g. ytsearch1:artist title)",
  };
}

export type SourceListCheck = { ok: true; sources: string[] } | { ok: false; reason: string };

/**
 * Validate a whole argv source list. Every element goes through
 * `validateSource` exactly as a lone source used to, and invalid elements are
 * dropped; the job is refused only when nothing usable is left. The album
 * fallback builds its list from MusicBrainz titles, so one odd track must not
 * take the rest of the album down with it.
 */
export function validateSources(raws: readonly unknown[]): SourceListCheck {
  if (!Array.isArray(raws) || raws.length === 0) return { ok: false, reason: "no sources given" };
  const sources: string[] = [];
  let firstReason = "";
  for (const raw of raws) {
    const check = validateSource(raw);
    if (check.ok) sources.push(check.source);
    else if (!firstReason) firstReason = check.reason;
  }
  if (sources.length === 0) return { ok: false, reason: firstReason || "no valid sources" };
  return { ok: true, sources };
}

/**
 * Where yt-dlp should look. Tracks use a YouTube search (accounting for the
 * `ytsearchN:` prefix); albums and playlists are expected to be given as a
 * real URL by the user, but a search query is a reasonable default.
 */
export function defaultSourceFor(type: MediaType, artist: string, title: string): string {
  const clean = (value: string) => value.replace(FORBIDDEN, " ").trim();
  const a = clean(artist);
  const t = clean(title);
  if (type === "track") return `ytsearch1:${a} ${t}`.trim();
  if (type === "album") return `ytsearch1:${a} ${t} full album`.trim();
  return `ytsearch1:${a} greatest hits`.trim();
}

/** The source a request will actually fetch, validated. */
export function resolveSource(request: MediaRequest): SourceCheck {
  const raw = request.ytdlpSource ?? defaultSourceFor(request.type, request.artist, request.title);
  return validateSource(raw);
}

/**
 * Did the user choose this source, or did we generate it?
 *
 * This matters more than it looks. `ytdlpSource` used to be written with
 * whatever the app generated, and a later fallback then read it back as "the
 * user chose this", which skipped the per-track logic and the full-album guard
 * — so one generated `… full album` search pinned a request to a single
 * full-album video forever. A stored value identical to the default for this
 * request is ours, not theirs.
 */
export function isUserSuppliedSource(request: MediaRequest): boolean {
  const stored = request.ytdlpSource?.trim();
  if (!stored) return false;
  return stored !== defaultSourceFor(request.type, request.artist, request.title);
}

// --- command construction --------------------------------------------------

/**
 * argv for yt-dlp. Every source is placed *last* so none of them can ever be
 * read as the value of a preceding option, and the caller is expected to have
 * validated them with `validateSource` first.
 */
export interface YtdlpArgOptions {
  /**
   * Album identity to stamp on every downloaded file, so an importer can file a
   * multi-track album download as one album.
   */
  album?: { title: string; artist: string };
  /**
   * Reject a single upload whose title says "full album". Set only when the
   * searches were generated for us (an album fallback split into per-track
   * searches); a user who pastes a full-album URL means it, so their source is
   * never filtered.
   */
  rejectFullAlbum?: boolean;
}

export function buildYtdlpArgs(sources: string[], opts: YtdlpArgOptions = {}): string[] {
  const y = config().ytdlp;
  const args: string[] = [
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
    // An album download goes into its own folder. Loose files give an importer
    // no album boundary, which is why a per-track album used to become one
    // single-track "album" per file.
    `${y.inboxContainerPath}/${
      opts.album ? `${folderLiteral(`${opts.album.artist} - ${opts.album.title}`)}/` : ""
    }%(meta_artist)s - %(meta_title)s [%(id)s].%(ext)s`,
    // Machine-readable bits we parse back out.
    "--print",
    "after_move:filepath",
    "--newline",
  ];

  if (sources.some((source) => /^ytsearch:/i.test(source))) {
    args.push("--no-playlist");
  }
  if (opts.rejectFullAlbum) {
    // yt-dlp's regex operator is `~=`; `!` negates it. (`!~` is not an operator
    // and makes yt-dlp reject the filter outright.)
    args.push("--match-filter", 'title !~= "(?i)full album"');
  }

  // Album downloads are separate searches, one per track, so nothing ties them
  // together as a record. Stamping the album and its artist onto each file is
  // what lets an importer file them as one album rather than one single-track
  // "album" per file. The value is a literal, so a colon in it would be read as
  // the FROM:TO separator — hence metaLiteral().
  if (opts.album) {
    const title = metaLiteral(opts.album.title);
    const artist = metaLiteral(opts.album.artist);
    if (title) args.push("--parse-metadata", `${title}:meta_album`);
    if (artist) args.push("--parse-metadata", `${artist}:meta_albumartist`);
  }
  args.push(...y.extraArgs);
  // Last: the user-controlled values, so nothing can consume one as an option.
  args.push(...sources);
  return args;
}

/** Rewrite container paths to host paths when the app runs yt-dlp itself. */
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

/**
 * The argv that will be executed, for diagnostics. Both drivers ultimately run
 * `yt-dlp`; the queue driver just runs it in the worker container instead of
 * inside the app.
 */
export function commandFor(sources: string[], opts: YtdlpArgOptions = {}): { cmd: string; args: string[] } {
  const args = buildYtdlpArgs(sources, opts);
  if (config().ytdlp.driver === "local") {
    return { cmd: "yt-dlp", args: forLocalDriver(args) };
  }
  return { cmd: "yt-dlp", args };
}

/**
 * Map a container path from yt-dlp output onto the host filesystem.
 * Re-exported from the spool module, which owns the mapping contract.
 */
export { toHostPath } from "./spool";

// --- local execution -------------------------------------------------------

export function runYtdlp(
  sources: string[],
  opts: { onOutput?: (line: string) => void; rejectFullAlbum?: boolean; album?: { title: string; artist: string } } = {}
): Promise<RunOutcome> {
  const driver = config().ytdlp.driver;
  if (driver === "none") {
    return Promise.resolve({
      ok: false,
      skipped: true,
      files: [],
      error: "yt-dlp downloads are disabled (MUSICSEER_YTDLP_DRIVER=none)",
    });
  }
  if (driver === "queue") {
    return Promise.resolve({
      ok: false,
      skipped: true,
      files: [],
      error: "the queue driver runs jobs in the worker container; nothing to spawn here",
    });
  }

  const check = validateSources(sources);
  if (!check.ok) {
    return Promise.resolve({ ok: false, skipped: false, files: [], error: `invalid source: ${check.reason}` });
  }

  const { cmd, args } = commandFor(check.sources, { rejectFullAlbum: opts.rejectFullAlbum, album: opts.album });

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
      if (spool.isFileLine(trimmed)) {
        files.push(toHostPath(trimmed.trim()));
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
            ? `executable not found: ${cmd}. Install yt-dlp, or use MUSICSEER_YTDLP_DRIVER=queue with the worker container.`
            : err.message,
      });
    });

    child.on("close", (code) => {
      // Exit 0 with nothing fetched is only a success if files came out of it.
      const ok = code === 0 && files.length > 0;
      finish({
        ok,
        skipped: false,
        files,
        error: ok
          ? undefined
          : code === 0
            ? "yt-dlp completed without downloading anything new (already in the download archive?)"
            : stderrTail.trim() || `yt-dlp exited with code ${code}`,
      });
    });
  });
}

// --- queueing --------------------------------------------------------------

let running = 0;
interface PendingJob {
  request: MediaRequest;
  job: FallbackJob;
}
const pending: PendingJob[] = [];
const MAX_CONCURRENT = 1;

/**
 * What a fallback job should actually fetch. `sources` defaults to the
 * request's own single source; an album fallback supplies one search per track.
 */
export interface FallbackJob {
  sources?: string[];
  rejectFullAlbum?: boolean;
  /** Album identity to stamp on every file in the job. */
  album?: { title: string; artist: string };
}

/** Safe as a literal in `--parse-metadata FROM:TO` (colons separate FROM/TO). */
function metaLiteral(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/:/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * A literal used as a directory name in the output template. Path separators
 * would silently create extra nesting, so they are removed rather than escaped.
 */
function folderLiteral(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim()
    .slice(0, 120);
}

export function queueDepth(): { jobsRunning: number; jobsQueued: number } {
  if (config().ytdlp.driver === "queue") return spool.spoolDepth();
  return { jobsRunning: running, jobsQueued: pending.length };
}

export function enqueueFallback(request: MediaRequest, job: FallbackJob = {}): void {
  if (config().ytdlp.driver === "queue") {
    startQueuedJob(request, job);
    return;
  }
  if (pending.some((entry) => entry.request.id === request.id)) return;
  pending.push({ request, job });
  void pump();
}

/** The validated source list for a job: explicit ones, else the request's own. */
function jobSources(request: MediaRequest, job: FallbackJob): SourceListCheck {
  if (job.sources && job.sources.length > 0) return validateSources(job.sources);
  const check = resolveSource(request);
  return check.ok ? { ok: true, sources: [check.source] } : { ok: false, reason: check.reason };
}

/**
 * Human-readable form of what a job fetches. `request.ytdlpSource` must stay a
 * single valid source (it is re-validated later), so the track count lives here
 * and in statusDetail instead.
 */
function sourceSummary(request: MediaRequest, sources: string[]): string {
  if (sources.length <= 1) return sources[0] ?? "";
  return `${sources.length} tracks from ${request.albumTitle ?? request.title}`;
}

/** Hand the job to the worker container via the spool directory. */
function startQueuedJob(request: MediaRequest, job: FallbackJob = {}): void {
  const check = jobSources(request, job);
  if (!check.ok) {
    updateRequest(request.id, {
      status: "failed",
      statusDetail: "Invalid yt-dlp source",
      lastError: check.reason,
    });
    addEvent(request.id, "error", `Refused to queue yt-dlp: ${check.reason}`);
    return;
  }

  const result = spool.writeJob(
    request.id,
    buildYtdlpArgs(check.sources, { rejectFullAlbum: job.rejectFullAlbum, album: job.album })
  );
  if (!result.ok) {
    updateRequest(request.id, {
      status: "failed",
      statusDetail: "Could not queue the yt-dlp job",
      lastError: result.error,
    });
    addEvent(request.id, "error", `Could not queue the yt-dlp job: ${result.error}`);
    return;
  }

  const summary = sourceSummary(request, check.sources);
  updateRequest(request.id, {
    source: "ytdlp",
    status: "downloading",
    statusDetail: `Queued for the yt-dlp worker: ${summary}`,
    // Only a source the user chose is persisted; storing our own is what caused
    // a generated search to be mistaken for their choice on the next attempt.
    ytdlpSource: isUserSuppliedSource(request) ? request.ytdlpSource : null,
    fallbackAt: request.fallbackAt ?? new Date().toISOString(),
    attempts: request.attempts + 1,
    lastError: null,
  });
  addEvent(request.id, "info", `yt-dlp job queued for ${summary}`);
}

async function pump(): Promise<void> {
  while (running < MAX_CONCURRENT && pending.length > 0) {
    const entry = pending.shift()!;
    running += 1;
    // Never let a rejected job go unhandled: the queue must keep draining.
    void runFallback(entry.request, entry.job)
      .catch((err) => recordFailure(entry.request.id, err))
      .finally(() => {
        running -= 1;
        void pump();
      });
  }
}

function recordFailure(requestId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  updateRequest(requestId, { status: "failed", statusDetail: "yt-dlp job crashed", lastError: message });
  addEvent(requestId, "error", `yt-dlp job crashed: ${message}`);
}

/** Runs one fallback job in-process (local driver) and records the outcome. */
export async function runFallback(request: MediaRequest, job: FallbackJob = {}): Promise<RunOutcome> {
  const check = jobSources(request, job);
  if (!check.ok) {
    updateRequest(request.id, {
      status: "failed",
      statusDetail: "Invalid yt-dlp source",
      lastError: check.reason,
    });
    addEvent(request.id, "error", `Refused to run yt-dlp: ${check.reason}`);
    return { ok: false, skipped: false, files: [], error: check.reason };
  }

  const summary = sourceSummary(request, check.sources);
  updateRequest(request.id, {
    source: "ytdlp",
    status: "downloading",
    statusDetail: `yt-dlp: ${summary}`,
    fallbackAt: request.fallbackAt ?? new Date().toISOString(),
    attempts: request.attempts + 1,
  });
  addEvent(request.id, "info", `yt-dlp started for ${summary}`);

  const outcome = await runYtdlp(check.sources, {
    rejectFullAlbum: job.rejectFullAlbum,
    album: job.album,
    onOutput: (line) => {
      if (/^\[download\]\s+\d|\bDestination:/.test(line)) {
        updateRequest(request.id, { statusDetail: line.slice(0, 300) });
      }
    },
  });

  applyOutcome(request, outcome);
  return outcome;
}

/**
 * Poll the worker for a finished job and, once it lands, record it. This is
 * what advances queue-driver requests out of `downloading`.
 */
export function pollFallback(request: MediaRequest): void {
  const outcome = spool.readJob(request.id);
  if (!outcome) {
    const progress = spool.jobProgress(request.id);
    if (progress && progress !== request.statusDetail) {
      updateRequest(request.id, { statusDetail: progress });
    }
    return;
  }
  applyOutcome(request, outcome);
  spool.clearJob(request.id);
}

/** Map one finished job onto the request's next state. Shared by both drivers. */
export function applyOutcome(request: MediaRequest, outcome: RunOutcome): void {
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
    return;
  }

  if (merged.length > 0) {
    // Files landed but yt-dlp still reported an error: keep the files.
    updateRequest(request.id, {
      status: "import_pending",
      statusDetail: `${merged.length} file(s) in the inbox, but yt-dlp exited with an error`,
      files: merged,
      lastError: outcome.error ?? null,
      completedAt: new Date().toISOString(),
    });
    addEvent(request.id, "warn", outcome.error ?? "yt-dlp exited with an error after downloading");
    return;
  }

  updateRequest(request.id, {
    status: "failed",
    statusDetail: outcome.skipped ? "yt-dlp is disabled" : "yt-dlp failed",
    lastError: outcome.error ?? "unknown error",
  });
  addEvent(request.id, "error", outcome.error ?? "yt-dlp failed");
}
