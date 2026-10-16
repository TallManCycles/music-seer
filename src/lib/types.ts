export type MediaType = "artist" | "album" | "track";

export type RequestSource = "lidarr" | "ytdlp";

/**
 * Lifecycle of a request.
 *
 *   pending            created, not yet handed to Lidarr
 *   submitted          added to Lidarr, waiting for a download
 *   processing         Lidarr is actively downloading / importing
 *   fallback_queued    Lidarr window expired, job queued for yt-dlp
 *   downloading        a yt-dlp job is running
 *   import_pending     yt-dlp finished; audio is in the inbox, not the library
 *   available          tracks are present in the library
 *   failed             gave up; see lastError
 *   cancelled          user cancelled
 */
export type RequestStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "fallback_queued"
  | "downloading"
  | "import_pending"
  | "available"
  | "failed"
  | "cancelled";

export interface SearchResult {
  type: MediaType;
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  /** For albums/tracks: the release-group MBID Lidarr keys albums on. */
  releaseGroupMbid?: string;
  year?: string;
  coverUrl?: string;
  subtitle?: string;
}

export interface MediaRequest {
  id: number;
  type: MediaType;
  mbid: string;
  releaseGroupMbid?: string;
  title: string;
  artist: string;
  artistMbid?: string;
  albumTitle?: string;
  year?: string;
  coverUrl?: string;
  source: RequestSource;
  status: RequestStatus;
  statusDetail?: string;
  lidarrArtistId?: number;
  lidarrAlbumId?: number;
  /** What yt-dlp will actually fetch: a URL or a `ytsearchN:` query. */
  ytdlpSource?: string;
  files: string[];
  autoFallback: boolean;
  fallbackAfterMinutes: number;
  requestedAt: string;
  submittedAt?: string;
  fallbackAt?: string;
  completedAt?: string;
  updatedAt: string;
  lastError?: string;
  attempts: number;
}

export interface RequestEvent {
  id: number;
  requestId: number;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

/** Result of one yt-dlp job, however it was executed. */
export interface RunOutcome {
  ok: boolean;
  files: string[];
  error?: string;
  skipped: boolean;
}

export interface CreateRequestBody {
  type: MediaType;
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  releaseGroupMbid?: string;
  year?: string;
  coverUrl?: string;
  autoFallback?: boolean;
  fallbackAfterMinutes?: number;
}
