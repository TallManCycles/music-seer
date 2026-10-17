import { config } from "./config";
import * as db from "./db";
import { invalidateSuggestions } from "./discover";
import * as jellyfin from "./jellyfin";
import * as lidarr from "./lidarr";
import { jellyfinReady, lidarrReady } from "./settings";
import { enqueueFallback, pollFallback, resolveSource, validateSource } from "./ytdlp";
import * as spool from "./spool";
import { isMusicBrainzId } from "./charts";
import {
  releaseGroupForRecording,
  releaseGroupForRelease,
  findReleaseGroupByName,
  tracklistForReleaseGroup,
  type AlbumTrack,
} from "./musicbrainz";
import type { CreateRequestBody, MediaRequest, MediaType, RequestStatus } from "./types";

// --- status helpers --------------------------------------------------------

export function isTerminal(status: RequestStatus): boolean {
  return status === "available" || status === "failed" || status === "cancelled";
}

// --- request creation ------------------------------------------------------

export interface CreateOutcome {
  request: MediaRequest;
  duplicate: boolean;
  warning?: string;
}

export async function createRequest(body: CreateRequestBody): Promise<CreateOutcome> {
  const type = body.type;
  const mbid = body.mbid;
  if (!mbid || !body.title) throw new Error("mbid and title are required");

  // Track requests are funnelled through their album, so make sure we know
  // which release group to give Lidarr.
  let releaseGroupMbid = body.releaseGroupMbid;
  let albumTitle: string | undefined;
  let artist = body.artist;
  let artistMbid = body.artistMbid;
  if (type === "track" && !releaseGroupMbid) {
    try {
      const resolved = await releaseGroupForRecording(mbid);
      releaseGroupMbid = resolved.releaseGroupMbid;
      albumTitle = resolved.albumTitle;
      artist = artist || resolved.artist || "";
      artistMbid = artistMbid ?? resolved.artistMbid;
    } catch {
      // Best effort; the fallback path does not need an album.
    }
  }

  // Chart entries arrive keyed by release, and Lidarr keys albums on the release
  // group — so resolve it rather than failing the request with "no release group".
  let unresolvedChartEntry = false;
  if (type === "album" && !releaseGroupMbid) {
    try {
      if (isMusicBrainzId(mbid)) {
        const resolved = await releaseGroupForRelease(mbid);
        if (resolved) {
          releaseGroupMbid = resolved.releaseGroupMbid;
          albumTitle = albumTitle ?? resolved.title;
          artist = artist || resolved.artist || "";
        }
      } else {
        // A regional chart entry: Apple gives no MusicBrainz ids, so the release
        // group has to be found by name. Reported after the row exists, so the
        // failure lands in the request log rather than in a stack trace.
        const resolved = await findReleaseGroupByName(artist || body.artist, body.title);
        if (resolved) {
          releaseGroupMbid = resolved.releaseGroupMbid;
          albumTitle = albumTitle ?? resolved.title;
          artist = artist || resolved.artist;
          artistMbid = artistMbid ?? resolved.artistMbid;
        } else {
          unresolvedChartEntry = true;
        }
      }
    } catch {
      // Falls through to the existing "no release group known" error.
    }
  }

  const cfg = config();
  const existing = db.findByIdentity(type, mbid);

  if (existing && (!isTerminal(existing.status) || existing.status === "available")) {
    return { request: existing, duplicate: true };
  }

  let request: MediaRequest;
  if (existing) {
    // Re-request: reuse the row so the event log and id stay stable.
    db.updateRequest(existing.id, {
      status: "pending",
      statusDetail: null,
      source: "lidarr",
      files: [],
      lastError: null,
      completedAt: null,
      fallbackAt: null,
      attempts: 0,
      coverUrl: body.coverUrl ?? existing.coverUrl ?? null,
      year: body.year ?? existing.year ?? null,
      releaseGroupMbid: releaseGroupMbid ?? existing.releaseGroupMbid ?? null,
      albumTitle: albumTitle ?? existing.albumTitle ?? null,
      artist: artist || existing.artist,
      artistMbid: artistMbid ?? existing.artistMbid ?? null,
      autoFallback: body.autoFallback ?? existing.autoFallback,
      fallbackAfterMinutes: body.fallbackAfterMinutes ?? existing.fallbackAfterMinutes,
    });
    db.addEvent(existing.id, "info", "Re-requested");
    request = db.getRequest(existing.id)!;
  } else {
    request = db.insertRequest({
      type,
      mbid,
      releaseGroupMbid,
      title: body.title,
      artist,
      artistMbid,
      albumTitle,
      year: body.year,
      coverUrl: body.coverUrl,
      autoFallback: body.autoFallback ?? true,
      fallbackAfterMinutes: body.fallbackAfterMinutes ?? cfg.fallbackAfterMinutes,
    });
    db.addEvent(request.id, "info", `Request created: ${type} "${body.title}"`);
  }

  // Nothing to acquire if the library already has it. Jellyfin is the library
  // of record, so check it before troubling Lidarr at all.
  const inLibrary = await jellyfinLookup(request);
  if (inLibrary?.found) {
    db.updateRequest(request.id, {
      status: "available",
      statusDetail: inLibrary.detail,
      completedAt: new Date().toISOString(),
      lastError: null,
    });
    db.addEvent(request.id, "info", `Already in the library — ${inLibrary.detail}`);
    return { request: db.getRequest(request.id)!, duplicate: false };
  }

  // A chart entry that could not be matched on MusicBrainz cannot be handed to
  // Lidarr at all, so fail it with the reason instead of a stack trace.
  if (unresolvedChartEntry) {
    db.updateRequest(request.id, {
      status: "failed",
      statusDetail: "Not on MusicBrainz",
      lastError: `Could not match "${body.title}" by ${body.artist || "that artist"} on MusicBrainz, so Lidarr cannot be asked for it.`,
    });
    db.addEvent(
      request.id,
      "error",
      `Could not match "${body.title}" on MusicBrainz — nothing was sent to Lidarr`
    );
    return { request: db.getRequest(request.id)!, duplicate: false };
  }

  await submitToLidarr(request.id);
  // The shelf should reflect this request straight away, not in 30 minutes.
  invalidateSuggestions();
  return { request: db.getRequest(request.id)!, duplicate: false };
}

// --- Lidarr submission -----------------------------------------------------

export async function submitToLidarr(requestId: number): Promise<void> {
  const request = db.getRequest(requestId);
  if (!request || isTerminal(request.status)) return;

  const cfg = config();

  if (!lidarrReady()) {
    db.addEvent(request.id, "warn", "Lidarr is not configured — falling back to yt-dlp");
    await startFallback(request.id, "Lidarr is not configured");
    return;
  }

  try {
    const artistMbid = request.artistMbid ?? request.mbid; // artist requests carry their own MBID
    const artistResult = await lidarr.ensureArtist(artistMbid, request.artist || request.title);
    db.addEvent(
      request.id,
      "info",
      artistResult.created
        ? `Added artist to Lidarr (id ${artistResult.artist.id})`
        : `Artist already in Lidarr (id ${artistResult.artist.id})`
    );

    let albumId: number | undefined;
    if (request.type === "album" || request.type === "track") {
      const rgid = request.releaseGroupMbid;
      if (!rgid) throw new Error("no release group known for this request");
      const album = await lidarr.addAlbum(
        artistResult.artist.id,
        rgid,
        request.artist,
        request.albumTitle ?? request.title
      );
      albumId = album.id;
      db.addEvent(request.id, "info", `Added album to Lidarr (id ${album.id})`);
      if (cfg.lidarr.searchOnAdd) {
        await lidarr.triggerAlbumSearch([album.id]).catch(() => undefined);
      }
    } else if (cfg.lidarr.searchOnAdd) {
      await lidarr.triggerArtistSearch(artistResult.artist.id).catch(() => undefined);
    }

    db.updateRequest(request.id, {
      status: "submitted",
      statusDetail:
        request.type === "artist"
          ? "Monitoring artist in Lidarr"
          : "Album monitored; waiting for Lidarr to grab it",
      lidarrArtistId: artistResult.artist.id,
      lidarrAlbumId: albumId ?? null,
      submittedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.addEvent(request.id, "warn", `Lidarr could not take this request: ${message}`);

    // "Lidarr has no release for this" is precisely the situation the yt-dlp
    // fallback exists for, so do not make the user wait out the window.
    const notFound = /could not find/i.test(message);
    if (request.autoFallback && notFound) {
      await startFallback(request.id, `Lidarr has no release: ${message}`);
      return;
    }
    db.updateRequest(request.id, {
      status: "failed",
      statusDetail: "Lidarr submission failed",
      lastError: message,
    });
  }
}

// --- reconciliation --------------------------------------------------------

interface Availability {
  available: boolean;
  processing: boolean;
  detail: string;
  error?: string;
}

/**
 * Ask Jellyfin whether we already have this. `null` means "cannot say"
 * (not configured, or the server did not answer) — callers must not read that
 * as "no". A warning is logged so a broken Jellyfin does not look like an
 * empty library.
 */
async function jellyfinLookup(request: MediaRequest): Promise<jellyfin.LibraryLookup | null> {
  if (!jellyfinReady()) return null;
  try {
    return await jellyfin.findInLibrary({
      type: request.type,
      title: request.title,
      artist: request.artist,
      albumTitle: request.albumTitle,
    });
  } catch (err) {
    db.addEvent(
      request.id,
      "warn",
      `Could not query Jellyfin: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function checkAvailability(request: MediaRequest): Promise<Availability> {
  const threshold = config().completeThreshold * 100;

  // Jellyfin is where the music is, so it is the library of record. Lidarr
  // still supplies "is it on its way" and the download error text.
  const inLibrary = await jellyfinLookup(request);

  // What Lidarr's own bookkeeping thinks, kept only as a fallback for when
  // Jellyfin is not configured or cannot be reached.
  let lidarrAvailable = false;
  let lidarrDetail = "Lidarr is not configured";
  let lidarrError: string | undefined;
  let processing = false;

  if (lidarrReady()) {
    const queue = await lidarr.queueDetails({
      artistId: request.lidarrArtistId,
      albumId: request.lidarrAlbumId,
    });
    const active = queue.filter((q) =>
      ["downloading", "importPending", "importing"].includes(q.trackedDownloadState ?? "")
    );
    const failed = queue.filter((q) =>
      ["importFailed", "failedPending", "importBlocked"].includes(q.trackedDownloadState ?? "")
    );
    processing = active.length > 0;
    lidarrError = failed[0]?.errorMessage;

    if (request.type === "artist") {
      if (!request.lidarrArtistId) {
        lidarrDetail = "no artist id";
      } else {
        const artist = await lidarr.getArtist(request.lidarrArtistId);
        const pct = artist.statistics?.percentOfTracks ?? 0;
        const fileCount = artist.statistics?.trackFileCount ?? 0;
        lidarrAvailable = fileCount > 0 && pct >= threshold;
        lidarrDetail = `${Math.round(pct)}% of tracks on disk (${fileCount} files)`;
      }
    } else if (!request.lidarrAlbumId) {
      lidarrDetail = "no album id";
    } else {
      const album = await lidarr.getAlbum(request.lidarrAlbumId);
      const pct = album.statistics?.percentOfTracks ?? 0;
      const fileCount = album.statistics?.trackFileCount ?? 0;
      lidarrAvailable = fileCount > 0 && pct >= threshold;
      lidarrDetail = `${Math.round(pct)}% of tracks on disk (${fileCount} files)`;

      if (request.type === "track") {
        const tracks = await lidarr.getTracksForAlbum(request.lidarrAlbumId);
        const want = normalizeTitle(request.title);
        const match = tracks.find((t) => normalizeTitle(t.title) === want);
        if (match) {
          lidarrAvailable = match.hasFile;
          lidarrDetail = match.hasFile ? "track file present" : `track missing (album ${Math.round(pct)}%)`;
        } else {
          lidarrDetail = `track not matched; album ${Math.round(pct)}% complete`;
        }
      }
    }
  }

  const available = inLibrary ? inLibrary.found : lidarrAvailable;
  const detail = inLibrary
    ? inLibrary.found
      ? inLibrary.detail
      : `${lidarrDetail}; not in Jellyfin yet`
    : lidarrDetail;

  return { available, processing, detail, error: lidarrError };
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[\(\[][^)\]]*[)\]]\s*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** One pass over a single request: refresh status, or trigger the fallback. */
export async function reconcile(request: MediaRequest): Promise<void> {
  if (isTerminal(request.status)) return;

  if (request.source === "ytdlp") {
    // A yt-dlp job is owned by the queue, not by Lidarr.
    if (request.status === "downloading") pollFallback(request);
    else if (request.status === "import_pending") await recheckImport(request);
    else if (request.status === "fallback_queued" && !spool.hasJob(request.id)) {
      // The job was recorded but never actually queued (e.g. the process died
      // in between). Re-queue it rather than leaving the request stuck.
      enqueueFallback(request);
    }
    return;
  }

  const elapsedMs = Date.now() - new Date(request.submittedAt ?? request.requestedAt).getTime();
  const windowMs = request.fallbackAfterMinutes * 60_000;
  // fallbackAfterMinutes === 0 means "never fall back automatically"; the
  // request has to be pushed to yt-dlp by hand. Do not treat 0 as "now".
  const autoFallbackDue =
    request.autoFallback && request.fallbackAfterMinutes > 0 && elapsedMs >= windowMs;

  let availability: Availability;
  try {
    availability = await checkAvailability(request);
  } catch (err) {
    db.addEvent(
      request.id,
      "warn",
      `Could not read Lidarr status: ${err instanceof Error ? err.message : String(err)}`
    );
    if (autoFallbackDue) {
      await startFallback(request.id, "Lidarr status unavailable");
    }
    return;
  }

  if (availability.available) {
    db.updateRequest(request.id, {
      status: "available",
      statusDetail: availability.detail,
      completedAt: new Date().toISOString(),
    });
    db.addEvent(request.id, "info", `Available — ${availability.detail}`);
    return;
  }

  // Show progress while Lidarr is still working, but never let that stop the
  // fallback clock: a stuck download is exactly what yt-dlp is for.
  db.updateRequest(request.id, {
    status: availability.processing ? "processing" : "submitted",
    statusDetail: availability.error
      ? `${availability.detail} — reported: ${availability.error}`
      : availability.detail,
  });

  if (autoFallbackDue) {
    await startFallback(
      request.id,
      availability.error
        ? `Lidarr reported: ${availability.error}`
        : `Lidarr did not deliver within ${request.fallbackAfterMinutes} minutes`
    );
  }
}

// --- fallback --------------------------------------------------------------

/** Most tracks one fallback job will ask yt-dlp for; a cap on runaway albums. */
const MAX_ALBUM_TRACK_SOURCES = 30;

interface AlbumFallbackSources {
  sources: string[];
  /** True when the sources were generated per track (so reject "Full Album"). */
  rejectFullAlbum: boolean;
}

/**
 * The sources an album fallback should fetch.
 *
 * A user-supplied source is theirs and is passed through untouched. Otherwise
 * the album's tracklist is fetched from MusicBrainz and turned into one
 * `ytsearch1:` per track, so the fallback downloads the album's tracks rather
 * than whichever single "Full Album" video ranks first. Anything unexpected — no
 * release group, no tracklist, a MusicBrainz failure — falls back to the single
 * search, so this can only improve on the old behaviour.
 */
async function albumFallbackSources(
  request: MediaRequest,
  fallbackSource: string
): Promise<AlbumFallbackSources> {
  const single: AlbumFallbackSources = { sources: [fallbackSource], rejectFullAlbum: false };
  if (request.type !== "album") return single;
  if (request.ytdlpSource) return single; // the user chose this source
  if (!request.releaseGroupMbid) return single;

  let tracks: AlbumTrack[];
  try {
    tracks = await tracklistForReleaseGroup(request.releaseGroupMbid);
  } catch (err) {
    db.addEvent(
      request.id,
      "warn",
      `Could not fetch the tracklist for "${request.title}" (${
        err instanceof Error ? err.message : String(err)
      }) — falling back to a single search`
    );
    return single;
  }
  if (tracks.length === 0) return single;

  const sources: string[] = [];
  const seen = new Set<string>();
  for (const track of tracks.slice(0, MAX_ALBUM_TRACK_SOURCES)) {
    // Credit a feature to whoever MusicBrainz says performs the track.
    const artist = track.artist && track.artist !== request.artist ? track.artist : request.artist;
    const check = validateSource(`ytsearch1:${artist} ${track.title}`);
    if (!check.ok || seen.has(check.source)) continue;
    seen.add(check.source);
    sources.push(check.source);
  }
  if (sources.length === 0) return single;

  return { sources, rejectFullAlbum: true };
}

export async function startFallback(requestId: number, reason: string): Promise<void> {
  const request = db.getRequest(requestId);
  if (!request || isTerminal(request.status)) return;
  if (request.source === "ytdlp" && request.status === "downloading") return;

  // Reject a bad source before the request is marked as handed off, so an
  // unusable URL fails loudly instead of queueing a job that cannot run.
  const check = resolveSource(request);
  if (!check.ok) {
    db.updateRequest(requestId, {
      status: "failed",
      statusDetail: "Invalid yt-dlp source",
      lastError: check.reason,
    });
    db.addEvent(requestId, "error", `Refused to queue yt-dlp: ${check.reason}`);
    return;
  }

  // An album that fell back on its own becomes one search per track.
  const album = await albumFallbackSources(request, check.source);
  const summary =
    album.sources.length > 1
      ? `${album.sources.length} tracks from ${request.albumTitle ?? request.title}`
      : check.source;

  db.updateRequest(requestId, {
    source: "ytdlp",
    status: "fallback_queued",
    statusDetail:
      album.sources.length > 1 ? `yt-dlp: ${summary}` : `Queued for yt-dlp — ${reason}`,
    // A single valid source, not the "9 tracks" summary: this is re-validated.
    ytdlpSource: album.sources[0] ?? check.source,
    fallbackAt: new Date().toISOString(),
  });
  db.addEvent(
    requestId,
    "info",
    album.sources.length > 1
      ? `Handing off to yt-dlp: ${summary} (${reason})`
      : `Handing off to yt-dlp: ${reason}`
  );

  enqueueFallback(db.getRequest(requestId)!, {
    sources: album.sources,
    rejectFullAlbum: album.rejectFullAlbum,
  });
  invalidateSuggestions();
}

/**
 * A yt-dlp download has landed in the inbox. It is only really available once
 * Jellyfin can see it, which is what closes the `import_pending` state — this
 * used to be a dead end that never became `available`.
 */
export async function recheckImport(request: MediaRequest): Promise<void> {
  const inLibrary = await jellyfinLookup(request);

  if (inLibrary?.found) {
    db.updateRequest(request.id, {
      status: "available",
      statusDetail: inLibrary.detail,
      completedAt: new Date().toISOString(),
      lastError: null,
    });
    db.addEvent(request.id, "info", `Imported — ${inLibrary.detail}`);
    return;
  }

  if (inLibrary === null) {
    // Jellyfin is not configured or is unreachable, so there is nothing to
    // confirm the import against. Say so rather than guessing.
    const detail = jellyfinReady()
      ? "Downloaded to the inbox; Jellyfin could not be reached to confirm the import"
      : "Downloaded to the inbox; set MUSICSEER_JELLYFIN_URL to confirm imports automatically";
    if (request.statusDetail !== detail) db.updateRequest(request.id, { statusDetail: detail });
    return;
  }

  const detail = "In the inbox — waiting for the import step to move it into the library";
  if (request.statusDetail !== detail) {
    db.updateRequest(request.id, { statusDetail: detail });
    db.addEvent(request.id, "info", "Waiting for the downloaded files to be imported");
  }
}

/**
 * Nudge the things that turn a downloaded file into a library file. Jellyfin is
 * refreshed because it is the library of record and it is what the app checks;
 * the Lidarr scan is kept for setups where the inbox is a folder Lidarr watches
 * itself. Both are attempted, and both outcomes are reported in one place.
 */
export async function requestImportScan(requestId: number): Promise<MediaRequest | null> {
  const request = db.getRequest(requestId);
  if (!request) return null;

  const done: string[] = [];
  const failed: string[] = [];

  if (jellyfinReady()) {
    try {
      await jellyfin.refreshLibrary();
      done.push("Jellyfin");
      db.addEvent(requestId, "info", "Asked Jellyfin to rescan its libraries");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`Jellyfin: ${message}`);
      db.addEvent(requestId, "error", `Jellyfin library refresh failed: ${message}`);
    }
  }

  if (lidarrReady()) {
    try {
      await lidarr.triggerImportScan();
      done.push("Lidarr");
      db.addEvent(requestId, "info", "Asked Lidarr to scan for completed downloads");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push(`Lidarr: ${message}`);
      db.addEvent(requestId, "error", `Lidarr import scan failed: ${message}`);
    }
  }

  if (done.length === 0 && failed.length === 0) {
    db.addEvent(
      requestId,
      "warn",
      "Cannot trigger an import scan: neither Jellyfin nor Lidarr is configured"
    );
    return db.getRequest(requestId);
  }

  db.updateRequest(requestId, {
    statusDetail: done.length
      ? `Library rescan requested in ${done.join(" and ")}`
      : `Rescan failed — ${failed.join("; ")}`,
  });
  return db.getRequest(requestId);
}

export async function forceFallback(requestId: number, source?: string): Promise<MediaRequest | null> {
  const request = db.getRequest(requestId);
  if (!request) return null;
  if (isTerminal(request.status)) {
    // Allow re-running an available/failed request through yt-dlp.
    db.updateRequest(requestId, { status: "fallback_queued", completedAt: null, lastError: null });
  }
  if (source) db.updateRequest(requestId, { ytdlpSource: source });
  await startFallback(requestId, "manually requested via yt-dlp");
  return db.getRequest(requestId);
}

export function cancelRequest(requestId: number): MediaRequest | null {
  const request = db.getRequest(requestId);
  if (!request) return null;
  // Drop any queued job so the worker does not keep filling the inbox for a
  // request that no longer exists. A job already in flight finishes, but its
  // result is discarded by the queue.
  spool.clearJob(requestId);
  db.updateRequest(requestId, {
    status: "cancelled",
    statusDetail: "Cancelled by user",
  });
  db.addEvent(requestId, "info", "Request cancelled");
  invalidateSuggestions();
  return db.getRequest(requestId);
}
