import { config, lidarrConfigured } from "./config";

export class LidarrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "LidarrError";
  }
}

// --- low-level HTTP --------------------------------------------------------

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  init?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }
): Promise<T> {
  const cfg = config().lidarr;
  if (!lidarrConfigured()) {
    throw new LidarrError("Lidarr is not configured (set MUSICSEER_LIDARR_URL and API key)");
  }
  const url = new URL(`${cfg.url}/api/v1/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      "X-Api-Key": cfg.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LidarrError(
      `Lidarr ${method} ${path} -> ${res.status} ${res.statusText}`,
      res.status,
      text.slice(0, 800)
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LidarrError(`Lidarr returned non-JSON for ${path}`, res.status, text.slice(0, 400));
  }
}

// --- resource types --------------------------------------------------------

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  monitored: boolean;
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
  statistics?: {
    albumCount: number;
    trackCount: number;
    trackFileCount: number;
    totalTrackCount: number;
    percentOfTracks: number;
  };
}

export interface LidarrAlbum {
  id: number;
  title: string;
  foreignAlbumId: string;
  artistId: number;
  monitored: boolean;
  albumType?: string;
  releaseDate?: string;
  images?: Array<{ coverType: string; url: string; remoteUrl?: string }>;
  statistics?: {
    trackCount: number;
    trackFileCount: number;
    totalTrackCount: number;
    percentOfTracks: number;
    sizeOnDisk?: number;
  };
  [key: string]: unknown;
}

export interface LidarrTrack {
  id: number;
  title: string;
  albumId: number;
  hasFile: boolean;
}

export interface QueueRecord {
  id: number;
  artistId?: number;
  albumId?: number;
  title?: string;
  status?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  errorMessage?: string;
  sizeleft?: number;
  timeleft?: string;
}

export interface LidarrProfile {
  id: number;
  name: string;
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace?: number;
}

// --- connectivity ----------------------------------------------------------

export interface LidarrStatus {
  ok: boolean;
  version?: string;
  error?: string;
}

export async function systemStatus(): Promise<LidarrStatus> {
  if (!lidarrConfigured()) return { ok: false, error: "not configured" };
  try {
    const s = await request<{ version: string }>("GET", "system/status");
    return { ok: true, version: s.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface Defaults {
  qualityProfileId: number;
  metadataProfileId: number;
  rootFolderPath: string;
}

let defaultsCache: Defaults | null = null;

/** Fill in profile/root-folder IDs that were left blank in the env. */
export async function resolveDefaults(): Promise<Defaults> {
  if (defaultsCache) return defaultsCache;
  const cfg = config().lidarr;
  const [qualities, metadatas, roots] = await Promise.all([
    request<LidarrProfile[]>("GET", "qualityprofile"),
    request<LidarrProfile[]>("GET", "metadataprofile"),
    request<RootFolder[]>("GET", "rootfolder"),
  ]);
  if (!roots.length) {
    throw new LidarrError("Lidarr has no root folders configured");
  }
  const qualityProfileId =
    cfg.qualityProfileId ?? qualities.find((q) => q.id > 0)?.id ?? qualities[0]?.id;
  const metadataProfileId =
    cfg.metadataProfileId ??
    metadatas.find((m) => m.name.toLowerCase() === "standard")?.id ??
    metadatas[0]?.id;
  const rootFolderPath =
    roots.find((r) => r.path === cfg.rootFolder)?.path ?? roots[0].path;

  if (!qualityProfileId || !metadataProfileId) {
    throw new LidarrError("Lidarr has no quality/metadata profiles configured");
  }
  defaultsCache = { qualityProfileId, metadataProfileId, rootFolderPath };
  return defaultsCache;
}

// --- artist lookup / add ---------------------------------------------------

/**
 * Lidarr supports a `lidarr:<mbid>` term for exact artist lookups (with
 * `mbid:` as a legacy spelling). We deliberately do *not* fall back to a name
 * search: binding a request to the wrong artist is worse than failing, because
 * failing hands the request to yt-dlp.
 */
function artistLookupTerms(mbid: string): string[] {
  return [`lidarr:${mbid}`, `mbid:${mbid}`];
}

export async function lookupArtist(mbid: string): Promise<LidarrArtist | null> {
  let lastErr: unknown = null;
  for (const term of artistLookupTerms(mbid)) {
    try {
      const results = await request<LidarrArtist[]>("GET", "artist/lookup", { query: { term } });
      const match = results.find((a) => a.foreignArtistId === mbid);
      if (match) return match;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

export async function getArtist(id: number): Promise<LidarrArtist> {
  return request<LidarrArtist>("GET", `artist/${id}`);
}

export async function findArtistByMbid(mbid: string): Promise<LidarrArtist | null> {
  const all = await request<LidarrArtist[]>("GET", "artist");
  return all.find((a) => a.foreignArtistId === mbid) ?? null;
}

export interface AddArtistResult {
  artist: LidarrArtist;
  created: boolean;
}

export async function ensureArtist(mbid: string, name?: string): Promise<AddArtistResult> {
  const existing = await findArtistByMbid(mbid);
  if (existing) return { artist: existing, created: false };

  const lookup = await lookupArtist(mbid);
  if (!lookup) {
    throw new LidarrError(`Lidarr could not find artist ${name ?? ""} (${mbid})`.trim());
  }

  const defaults = await resolveDefaults();
  const cfg = config().lidarr;
  const body = {
    ...lookup,
    id: 0,
    monitored: true,
    rootFolderPath: defaults.rootFolderPath,
    qualityProfileId: defaults.qualityProfileId,
    metadataProfileId: defaults.metadataProfileId,
    addOptions: {
      monitor: cfg.artistMonitor,
      searchForMissingAlbums: cfg.searchOnAdd,
    },
  };
  delete (body as Record<string, unknown>).statistics;

  const artist = await request<LidarrArtist>("POST", "artist", { body });
  return { artist, created: true };
}

// --- album lookup / add ----------------------------------------------------

/**
 * As with artists, only an exact `foreignAlbumId` match is trusted. The plain
 * text term is kept because Lidarr accepts it and *may* surface the right
 * release group, but a near-miss is discarded rather than guessed.
 */
function albumLookupTerms(releaseGroupMbid: string, artistName: string, albumTitle: string): string[] {
  const terms = [
    `lidarr:${releaseGroupMbid}`,
    `mbid:${releaseGroupMbid}`,
    `release-group:${releaseGroupMbid}`,
  ];
  const text = `${artistName} ${albumTitle}`.trim();
  if (text) terms.push(text);
  return terms;
}

export async function lookupAlbum(
  releaseGroupMbid: string,
  artistName = "",
  albumTitle = ""
): Promise<LidarrAlbum | null> {
  let lastErr: unknown = null;
  for (const term of albumLookupTerms(releaseGroupMbid, artistName, albumTitle)) {
    try {
      const results = await request<LidarrAlbum[]>("GET", "album/lookup", { query: { term } });
      const exact = results.find((a) => a.foreignAlbumId === releaseGroupMbid);
      if (exact) return exact;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

export async function getAlbum(id: number): Promise<LidarrAlbum> {
  return request<LidarrAlbum>("GET", `album/${id}`);
}

export async function listAlbumsForArtist(artistId: number): Promise<LidarrAlbum[]> {
  return request<LidarrAlbum[]>("GET", "album", { query: { artistId } });
}

export async function addAlbum(
  artistId: number,
  releaseGroupMbid: string,
  artistName: string,
  albumTitle: string
): Promise<LidarrAlbum> {
  // Reuse an album already tracked for this artist rather than erroring.
  const existing = (await listAlbumsForArtist(artistId)).find(
    (a) => a.foreignAlbumId === releaseGroupMbid
  );
  if (existing) {
    if (!existing.monitored) {
      return request<LidarrAlbum>("PUT", "album/monitor", {
        body: { albumIds: [existing.id], monitored: true },
      }).catch(() => existing);
    }
    return existing;
  }

  const lookup = await lookupAlbum(releaseGroupMbid, artistName, albumTitle);
  if (!lookup) {
    throw new LidarrError(
      `Lidarr could not find album ${artistName} - ${albumTitle} (${releaseGroupMbid})`
    );
  }

  const body: Record<string, unknown> = {
    ...lookup,
    id: 0,
    artistId,
    monitored: true,
    addOptions: { searchForNewAlbum: config().lidarr.searchOnAdd },
  };
  delete body.statistics;

  return request<LidarrAlbum>("POST", "album", { body });
}

// --- availability ----------------------------------------------------------

export async function getTracksForAlbum(albumId: number): Promise<LidarrTrack[]> {
  return request<LidarrTrack[]>("GET", "track", { query: { albumId } });
}

export async function queueDetails(filter: {
  artistId?: number;
  albumId?: number;
}): Promise<QueueRecord[]> {
  const data = await request<{ records: QueueRecord[] } | QueueRecord[]>("GET", "queue/details", {
    query: {
      artistId: filter.artistId,
      albumId: filter.albumId,
      includeArtist: true,
      includeAlbum: true,
    },
  });
  return Array.isArray(data) ? data : (data.records ?? []);
}

export async function triggerAlbumSearch(albumIds: number[]): Promise<void> {
  await request("POST", "command", {
    body: { name: "AlbumSearch", albumIds },
  });
}

export async function triggerArtistSearch(artistId: number): Promise<void> {
  await request("POST", "command", {
    body: { name: "ArtistSearch", artistId },
  });
}

export async function triggerImportScan(): Promise<void> {
  await request("POST", "command", { body: { name: "DownloadedAlbumsScan" } });
}
