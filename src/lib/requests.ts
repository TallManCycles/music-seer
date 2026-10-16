import { config, lidarrConfigured } from "./config";
import * as db from "./db";
import * as lidarr from "./lidarr";
import { enqueueFallback, pollFallback, resolveSource } from "./ytdlp";
import * as spool from "./spool";
import { releaseGroupForRecording } from "./musicbrainz";
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

  await submitToLidarr(request.id);
  return { request: db.getRequest(request.id)!, duplicate: false };
}

// --- Lidarr submission -----------------------------------------------------

export async function submitToLidarr(requestId: number): Promise<void> {
  const request = db.getRequest(requestId);
  if (!request || isTerminal(request.status)) return;

  const cfg = config();

  if (!lidarrConfigured()) {
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

async function checkAvailability(request: MediaRequest): Promise<Availability> {
  const threshold = config().completeThreshold * 100;
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

  if (request.type === "artist") {
    if (!request.lidarrArtistId) return { available: false, processing: false, detail: "no artist id" };
    const artist = await lidarr.getArtist(request.lidarrArtistId);
    const pct = artist.statistics?.percentOfTracks ?? 0;
    const fileCount = artist.statistics?.trackFileCount ?? 0;
    return {
      available: fileCount > 0 && pct >= threshold,
      processing: active.length > 0,
      detail: `${Math.round(pct)}% of tracks on disk (${fileCount} files)`,
      error: failed[0]?.errorMessage,
    };
  }

  if (!request.lidarrAlbumId) return { available: false, processing: false, detail: "no album id" };
  const album = await lidarr.getAlbum(request.lidarrAlbumId);
  const pct = album.statistics?.percentOfTracks ?? 0;
  const fileCount = album.statistics?.trackFileCount ?? 0;

  if (request.type === "track") {
    const tracks = await lidarr.getTracksForAlbum(request.lidarrAlbumId);
    const want = normalizeTitle(request.title);
    const match = tracks.find((t) => normalizeTitle(t.title) === want);
    if (match) {
      return {
        available: match.hasFile,
        processing: active.length > 0,
        detail: match.hasFile ? `track file present` : `track missing (album ${Math.round(pct)}%)`,
        error: failed[0]?.errorMessage,
      };
    }
    // Could not match the title exactly; fall back to album completeness.
    return {
      available: fileCount > 0 && pct >= threshold,
      processing: active.length > 0,
      detail: `track not matched; album ${Math.round(pct)}% complete`,
      error: failed[0]?.errorMessage,
    };
  }

  return {
    available: fileCount > 0 && pct >= threshold,
    processing: active.length > 0,
    detail: `${Math.round(pct)}% of tracks on disk (${fileCount} files)`,
    error: failed[0]?.errorMessage,
  };
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
    db.addEvent(request.id, "info", `Available via Lidarr — ${availability.detail}`);
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

  db.updateRequest(requestId, {
    source: "ytdlp",
    status: "fallback_queued",
    statusDetail: `Queued for yt-dlp — ${reason}`,
    ytdlpSource: check.source,
    fallbackAt: new Date().toISOString(),
  });
  db.addEvent(requestId, "info", `Handing off to yt-dlp: ${reason}`);

  enqueueFallback(db.getRequest(requestId)!);
}

/**
 * Ask Lidarr to rescan its completed-download folders. Only useful when the
 * inbox is somewhere Lidarr already watches (e.g. a download client's output
 * folder); otherwise importing stays a manual step.
 */
export async function requestImportScan(requestId: number): Promise<MediaRequest | null> {
  const request = db.getRequest(requestId);
  if (!request) return null;
  if (!lidarrConfigured()) {
    db.addEvent(requestId, "warn", "Cannot trigger an import scan: Lidarr is not configured");
    return db.getRequest(requestId);
  }
  try {
    await lidarr.triggerImportScan();
    db.addEvent(requestId, "info", "Asked Lidarr to scan for completed downloads");
    db.updateRequest(requestId, {
      statusDetail: "Import scan requested in Lidarr",
    });
  } catch (err) {
    db.addEvent(
      requestId,
      "error",
      `Import scan failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
  return db.getRequest(requestId);
}
