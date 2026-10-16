import path from "node:path";

/**
 * How a yt-dlp job actually runs.
 *
 *   queue  the app writes a job into a shared spool directory; a separate
 *          yt-dlp worker container picks it up. No Docker socket, and the
 *          web app never executes anything.
 *   local  the app shells out to a `yt-dlp` binary on its own PATH.
 *   none   downloads are queued but never run.
 */
export type YtdlpDriver = "queue" | "local" | "none";

export interface LidarrConfig {
  url: string;
  apiKey: string;
  rootFolder: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
  artistMonitor: "all" | "future" | "missing" | "none";
  searchOnAdd: boolean;
}

export interface YtdlpConfig {
  driver: YtdlpDriver;
  /** Image used by the standalone worker container (compose only). */
  image: string;
  /** Directory shared with the worker where jobs are written. */
  spoolPath: string;
  /** Inbox and config as the *worker* sees them (local driver: as the app sees them). */
  inboxHostPath: string;
  configHostPath: string;
  inboxContainerPath: string;
  configContainerPath: string;
  archive: string;
  extraArgs: string[];
}

export interface AppConfig {
  dbPath: string;
  userAgent: string;
  lidarr: LidarrConfig;
  ytdlp: YtdlpConfig;
  fallbackAfterMinutes: number;
  pollIntervalMinutes: number;
  completeThreshold: number;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function jsonArray(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Fall through: allow a whitespace-separated list as a convenience.
  }
  return value.split(/\s+/).filter(Boolean);
}

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const driver = (process.env.MUSICSEER_YTDLP_DRIVER ?? "local").trim() as YtdlpDriver;

  return {
    dbPath: path.resolve(
      /* turbopackIgnore: true */ cwd,
      process.env.MUSICSEER_DB_PATH ?? "./data/musicseer.db"
    ),
    userAgent:
      process.env.MUSICSEER_USER_AGENT ??
      "music-seer/0.1 (https://github.com/music-seer/music-seer)",
    lidarr: {
      url: (process.env.MUSICSEER_LIDARR_URL ?? "http://localhost:8686").replace(/\/+$/, ""),
      apiKey: process.env.MUSICSEER_LIDARR_API_KEY ?? "",
      rootFolder: process.env.MUSICSEER_LIDARR_ROOT_FOLDER ?? "/music",
      qualityProfileId: num(process.env.MUSICSEER_LIDARR_QUALITY_PROFILE_ID),
      metadataProfileId: num(process.env.MUSICSEER_LIDARR_METADATA_PROFILE_ID),
      artistMonitor: (process.env.MUSICSEER_LIDARR_ARTIST_MONITOR ?? "all") as LidarrConfig["artistMonitor"],
      searchOnAdd: bool(process.env.MUSICSEER_LIDARR_SEARCH_ON_ADD, true),
    },
    ytdlp: {
      driver: ["queue", "local", "none"].includes(driver) ? driver : "local",
      image: process.env.MUSICSEER_YTDLP_IMAGE ?? "jauderho/yt-dlp:latest",
      spoolPath: path.resolve(
        /* turbopackIgnore: true */ cwd,
        process.env.MUSICSEER_SPOOL_PATH ?? "./spool"
      ),
      inboxHostPath: process.env.MUSICSEER_INBOX_HOST_PATH ?? "/mnt/nas/aaron/music-inbox",
      configHostPath: process.env.MUSICSEER_YTDLP_CONFIG_HOST_PATH ?? "/home/aaron/docker/ytdlp",
      inboxContainerPath: process.env.MUSICSEER_INBOX_CONTAINER_PATH ?? "/inbox",
      configContainerPath: process.env.MUSICSEER_YTDLP_CONFIG_CONTAINER_PATH ?? "/config",
      archive: process.env.MUSICSEER_YTDLP_ARCHIVE ?? "musicseer_archive.txt",
      extraArgs: jsonArray(process.env.MUSICSEER_YTDLP_EXTRA_ARGS),
    },
    fallbackAfterMinutes: num(process.env.MUSICSEER_FALLBACK_AFTER_MINUTES) ?? 120,
    pollIntervalMinutes: num(process.env.MUSICSEER_POLL_INTERVAL_MINUTES) ?? 5,
    completeThreshold: clamp(num(process.env.MUSICSEER_LIDARR_COMPLETE_THRESHOLD) ?? 1, 0.5, 1),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

let cached: AppConfig | null = null;

/** Config is read once per process; env changes need a restart. */
export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function lidarrConfigured(): boolean {
  return Boolean(config().lidarr.url && config().lidarr.apiKey);
}
