import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MediaRequest, RequestEvent, RequestStatus, RequestSource } from "./types";
import { config } from "./config";

type Row = Record<string, unknown>;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = config().dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      type                   TEXT NOT NULL,
      mbid                   TEXT NOT NULL,
      release_group_mbid     TEXT,
      title                  TEXT NOT NULL,
      artist                 TEXT NOT NULL DEFAULT '',
      artist_mbid            TEXT,
      album_title            TEXT,
      year                   TEXT,
      cover_url              TEXT,
      source                 TEXT NOT NULL DEFAULT 'lidarr',
      status                 TEXT NOT NULL DEFAULT 'pending',
      status_detail          TEXT,
      lidarr_artist_id       INTEGER,
      lidarr_album_id        INTEGER,
      ytdlp_source           TEXT,
      files                  TEXT NOT NULL DEFAULT '[]',
      auto_fallback          INTEGER NOT NULL DEFAULT 1,
      fallback_after_minutes INTEGER NOT NULL DEFAULT 120,
      requested_at           TEXT NOT NULL,
      submitted_at           TEXT,
      fallback_at            TEXT,
      completed_at           TEXT,
      updated_at             TEXT NOT NULL,
      last_error             TEXT,
      attempts               INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_identity
      ON requests(type, mbid);

    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      at         TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      message    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id, id);
  `);
}

// --- row mapping -----------------------------------------------------------

function mapRequest(r: Row): MediaRequest {
  return {
    id: r.id as number,
    type: r.type as MediaRequest["type"],
    mbid: r.mbid as string,
    releaseGroupMbid: (r.release_group_mbid as string) ?? undefined,
    title: r.title as string,
    artist: r.artist as string,
    artistMbid: (r.artist_mbid as string) ?? undefined,
    albumTitle: (r.album_title as string) ?? undefined,
    year: (r.year as string) ?? undefined,
    coverUrl: (r.cover_url as string) ?? undefined,
    source: r.source as RequestSource,
    status: r.status as RequestStatus,
    statusDetail: (r.status_detail as string) ?? undefined,
    lidarrArtistId: (r.lidarr_artist_id as number) ?? undefined,
    lidarrAlbumId: (r.lidarr_album_id as number) ?? undefined,
    ytdlpSource: (r.ytdlp_source as string) ?? undefined,
    files: JSON.parse((r.files as string) ?? "[]"),
    autoFallback: Boolean(r.auto_fallback),
    fallbackAfterMinutes: r.fallback_after_minutes as number,
    requestedAt: r.requested_at as string,
    submittedAt: (r.submitted_at as string) ?? undefined,
    fallbackAt: (r.fallback_at as string) ?? undefined,
    completedAt: (r.completed_at as string) ?? undefined,
    updatedAt: r.updated_at as string,
    lastError: (r.last_error as string) ?? undefined,
    attempts: r.attempts as number,
  };
}

// --- queries ---------------------------------------------------------------

export function listRequests(): MediaRequest[] {
  const rows = getDb()
    .prepare(`SELECT * FROM requests ORDER BY id DESC`)
    .all() as Row[];
  return rows.map(mapRequest);
}

export function getRequest(id: number): MediaRequest | null {
  const row = getDb().prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as Row | undefined;
  return row ? mapRequest(row) : null;
}

export function findByIdentity(type: string, mbid: string): MediaRequest | null {
  const row = getDb()
    .prepare(`SELECT * FROM requests WHERE type = ? AND mbid = ?`)
    .get(type, mbid) as Row | undefined;
  return row ? mapRequest(row) : null;
}

export function listByStatus(statuses: RequestStatus[]): MediaRequest[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM requests WHERE status IN (${placeholders}) ORDER BY id ASC`)
    .all(...statuses) as Row[];
  return rows.map(mapRequest);
}

export interface InsertInput {
  type: string;
  mbid: string;
  releaseGroupMbid?: string;
  title: string;
  artist: string;
  artistMbid?: string;
  albumTitle?: string;
  year?: string;
  coverUrl?: string;
  autoFallback: boolean;
  fallbackAfterMinutes: number;
}

export function insertRequest(input: InsertInput): MediaRequest {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO requests
        (type, mbid, release_group_mbid, title, artist, artist_mbid, album_title, year,
         cover_url, source, status, auto_fallback, fallback_after_minutes,
         requested_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'lidarr', 'pending', ?,?,?,?)`
    )
    .run(
      input.type,
      input.mbid,
      input.releaseGroupMbid ?? null,
      input.title,
      input.artist,
      input.artistMbid ?? null,
      input.albumTitle ?? null,
      input.year ?? null,
      input.coverUrl ?? null,
      input.autoFallback ? 1 : 0,
      input.fallbackAfterMinutes,
      now,
      now
    );
  return getRequest(Number(info.lastInsertRowid))!;
}

export interface UpdateInput {
  status?: RequestStatus;
  statusDetail?: string | null;
  source?: RequestSource;
  lidarrArtistId?: number | null;
  lidarrAlbumId?: number | null;
  ytdlpSource?: string | null;
  files?: string[];
  submittedAt?: string | null;
  fallbackAt?: string | null;
  completedAt?: string | null;
  lastError?: string | null;
  attempts?: number;
  coverUrl?: string | null;
  autoFallback?: boolean;
  fallbackAfterMinutes?: number;
  releaseGroupMbid?: string | null;
  albumTitle?: string | null;
  artist?: string | null;
  artistMbid?: string | null;
  year?: string | null;
}

const COLUMN_MAP: Record<keyof UpdateInput, string> = {
  status: "status",
  statusDetail: "status_detail",
  source: "source",
  lidarrArtistId: "lidarr_artist_id",
  lidarrAlbumId: "lidarr_album_id",
  ytdlpSource: "ytdlp_source",
  files: "files",
  submittedAt: "submitted_at",
  fallbackAt: "fallback_at",
  completedAt: "completed_at",
  lastError: "last_error",
  attempts: "attempts",
  coverUrl: "cover_url",
  autoFallback: "auto_fallback",
  fallbackAfterMinutes: "fallback_after_minutes",
  releaseGroupMbid: "release_group_mbid",
  albumTitle: "album_title",
  artist: "artist",
  artistMbid: "artist_mbid",
  year: "year",
};

export function updateRequest(id: number, patch: UpdateInput): MediaRequest | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(COLUMN_MAP) as [keyof UpdateInput, string][]) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    const v = patch[key];
    if (key === "files") values.push(JSON.stringify(v ?? []));
    else if (typeof v === "boolean") values.push(v ? 1 : 0);
    else values.push(v ?? null);
  }
  if (sets.length === 0) return getRequest(id);
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE requests SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  return getRequest(id);
}

export function addEvent(
  requestId: number,
  level: RequestEvent["level"],
  message: string
): void {
  getDb()
    .prepare(`INSERT INTO events (request_id, at, level, message) VALUES (?,?,?,?)`)
    .run(requestId, new Date().toISOString(), level, message);
}

export function listEvents(requestId: number, limit = 50): RequestEvent[] {
  const rows = getDb()
    .prepare(`SELECT * FROM events WHERE request_id = ? ORDER BY id DESC LIMIT ?`)
    .all(requestId, limit) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    requestId: r.request_id as number,
    at: r.at as string,
    level: r.level as RequestEvent["level"],
    message: r.message as string,
  }));
}
