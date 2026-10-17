import { jellyfinCredentials, jellyfinReady, isUsableUrl, normalizeUrl } from "./settings";
import type { MediaType } from "./types";

/**
 * Jellyfin is the library of record: it answers "do you already have this?".
 * Lidarr stays responsible for acquiring what is missing, which is why
 * availability is no longer derived from Lidarr's disk statistics alone.
 *
 * Matching is deliberately conservative — an exact normalised name match, and
 * (when we know it) an artist match too. A false "available" is much worse
 * than a false "not yet", because it means a request is never downloaded.
 */

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  AlbumArtist?: string;
  Artists?: string[];
  Album?: string;
  ProductionYear?: number;
  /** Jellyfin's MusicBrainz plugin puts MBIDs here: exact IDs, no guessing. */
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
  DateCreated?: string;
}

export type MusicItemType = "MusicArtist" | "MusicAlbum" | "Audio";

/** Everything the app needs to display and match an item. */
const ITEM_FIELDS = "AlbumArtist,Artists,Album,ProductionYear,ProviderIds,ImageTags,DateCreated";

const ITEM_TYPES: Record<MediaType, MusicItemType> = {
  artist: "MusicArtist",
  album: "MusicAlbum",
  track: "Audio",
};

// --- low-level HTTP --------------------------------------------------------

/**
 * Jellyfin's documented auth is the `Authorization: MediaBrowser` header, and
 * Jellyfin 12 no longer accepts the older `X-Emby-Token` header that 10.x
 * servers use. Send both: 12+ reads the first, 10.x reads either. Getting this
 * wrong looks exactly like a bad API key (a 401 on every request), which is a
 * genuinely confusing failure to debug.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `MediaBrowser Client="music-seer", Device="server", DeviceId="music-seer", Version="0.1", Token="${apiKey}"`,
    "X-Emby-Token": apiKey,
  };
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  init?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }
): Promise<T> {
  const cfg = jellyfinCredentials();
  if (!jellyfinReady()) {
    throw new JellyfinError("Jellyfin is not configured (set the URL and API key on the Settings page)");
  }

  const url = new URL(`${cfg.url}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders(cfg.apiKey),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new JellyfinError(
      res.status === 401 || res.status === 403
        ? `Jellyfin rejected the API key (${res.status}) for ${path}`
        : `Jellyfin ${method} ${path} -> ${res.status} ${res.statusText}`,
      res.status,
      text.slice(0, 400)
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JellyfinError(`Jellyfin returned non-JSON for ${path}`, res.status, text.slice(0, 200));
  }
}

/**
 * Check a URL and key against an endpoint that actually requires the key, so a
 * rejected key is reported as such instead of looking like a healthy server.
 * `/System/Info/Public` needs no auth and therefore cannot tell you this.
 */
export async function verifyCredentials(creds: {
  url: string;
  apiKey: string;
}): Promise<{ ok: boolean; detail?: string; error?: string }> {
  if (!creds.url || !creds.apiKey) return { ok: false, error: "no URL or API key to test" };
  if (!isUsableUrl(creds.url)) return { ok: false, error: "that is not a valid http(s) URL" };
  try {
    const res = await fetch(`${normalizeUrl(creds.url)}/System/Info`, {
      headers: { ...authHeaders(creds.apiKey), Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Jellyfin rejected the API key (401)" };
    }
    if (!res.ok) return { ok: false, error: `Jellyfin answered ${res.status} ${res.statusText}` };
    const info = (await res.json()) as { Version?: string; ServerName?: string };
    return { ok: true, detail: `${info.ServerName ?? "Jellyfin"} ${info.Version ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- matching --------------------------------------------------------------

/** Lowercase, drop bracketed qualifiers and punctuation, collapse spaces. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/\s*[\(\[][^)\]]*[)\]]\s*/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  return left === right;
}

function itemArtists(item: JellyfinItem): string[] {
  const list = [item.AlbumArtist, ...(item.Artists ?? [])];
  return list.filter((v): v is string => Boolean(v && v.trim()));
}

/**
 * True when the item is credited to the artist we asked about. If the item
 * carries no artist information at all we accept the name match alone.
 */
function artistMatches(item: JellyfinItem, artist: string): boolean {
  if (!artist.trim()) return true;
  const artists = itemArtists(item);
  if (artists.length === 0) return true;
  return artists.some(
    (candidate) => namesMatch(candidate, artist) || normalizeName(candidate).includes(normalizeName(artist))
  );
}

// --- queries ---------------------------------------------------------------

export async function searchItems(opts: {
  types: MusicItemType[];
  term?: string;
  limit?: number;
}): Promise<JellyfinItem[]> {
  const cfg = jellyfinCredentials();
  const base = cfg.userId ? `Users/${encodeURIComponent(cfg.userId)}/Items` : "Items";
  const result = await request<{ Items?: JellyfinItem[] }>("GET", base, {
    query: {
      Recursive: true,
      IncludeItemTypes: opts.types.join(","),
      SearchTerm: opts.term,
      Fields: ITEM_FIELDS,
      Limit: opts.limit ?? 25,
      EnableTotalRecordCount: false,
    },
  });
  return result?.Items ?? [];
}

export interface LibraryLookup {
  found: boolean;
  detail: string;
  item?: JellyfinItem;
}

/**
 * Is this artist/album/track already in the library? Throws only on transport
 * problems — callers decide how loud to be about a missing library.
 */
export async function findInLibrary(request: {
  type: MediaType;
  title: string;
  artist: string;
  albumTitle?: string;
}): Promise<LibraryLookup> {
  const type = ITEM_TYPES[request.type];
  const term = [request.artist, request.type === "album" ? request.albumTitle ?? request.title : request.title]
    .filter(Boolean)
    .join(" ");
  const items = await searchItems({ types: [type], term, limit: 25 });

  for (const item of items) {
    if (item.Type !== type) continue;

    if (request.type === "artist") {
      if (namesMatch(item.Name, request.artist)) {
        return { found: true, detail: `in Jellyfin: artist "${item.Name}"`, item };
      }
      continue;
    }

    if (request.type === "album") {
      const wanted = request.albumTitle ?? request.title;
      if (namesMatch(item.Name, wanted) && artistMatches(item, request.artist)) {
        return { found: true, detail: `in Jellyfin: album "${item.Name}"`, item };
      }
      continue;
    }

    // Track.
    if (namesMatch(item.Name, request.title) && artistMatches(item, request.artist)) {
      const album = item.Album ? ` from "${item.Album}"` : "";
      return { found: true, detail: `in Jellyfin: "${item.Name}"${album}`, item };
    }
  }

  return { found: false, detail: "not in Jellyfin" };
}

/**
 * The music that is actually in the library, newest-sorted by name. This is
 * what the browse page shows, and what the suggestion engine compares against.
 */
export async function listAlbums(opts: { limit?: number; offset?: number } = {}): Promise<JellyfinItem[]> {
  const cfg = jellyfinCredentials();
  const base = cfg.userId ? `Users/${encodeURIComponent(cfg.userId)}/Items` : "Items";
  const result = await request<{ Items?: JellyfinItem[] }>("GET", base, {
    query: {
      Recursive: true,
      IncludeItemTypes: "MusicAlbum",
      Fields: ITEM_FIELDS,
      SortBy: "SortName",
      SortOrder: "Ascending",
      Limit: opts.limit ?? 500,
      StartIndex: opts.offset ?? 0,
      EnableTotalRecordCount: true,
    },
  });
  return result?.Items ?? [];
}

export async function listArtists(opts: { limit?: number } = {}): Promise<JellyfinItem[]> {
  const cfg = jellyfinCredentials();
  const base = cfg.userId ? `Users/${encodeURIComponent(cfg.userId)}/Items` : "Items";
  const result = await request<{ Items?: JellyfinItem[] }>("GET", base, {
    query: {
      Recursive: true,
      IncludeItemTypes: "MusicArtist",
      Fields: ITEM_FIELDS,
      SortBy: "SortName",
      Limit: opts.limit ?? 500,
      EnableTotalRecordCount: true,
    },
  });
  return result?.Items ?? [];
}

/** The MusicBrainz artist id Jellyfin has for an item, if its plugin supplies one. */
export function musicBrainzArtistId(item: JellyfinItem): string | undefined {
  const id = item.ProviderIds?.MusicBrainzArtist;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
}

/**
 * Where Jellyfin serves an item's cover. The api key is added by the proxy
 * route, never by the browser.
 */
export function imageEndpoint(itemId: string, size = 300): string {
  const cfg = jellyfinCredentials();
  const params = new URLSearchParams({
    maxHeight: String(size),
    quality: "90",
  });
  return `${cfg.url}/Items/${encodeURIComponent(itemId)}/Images/Primary?${params.toString()}`;
}

export async function imageResponse(itemId: string, size: number): Promise<Response> {
  const cfg = jellyfinCredentials();
  if (!jellyfinReady()) return new Response("jellyfin not configured", { status: 400 });
  const res = await fetch(imageEndpoint(itemId, size), {
    headers: { ...authHeaders(cfg.apiKey), Accept: "image/*" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return new Response("no image", { status: res.status });
  const body = await res.arrayBuffer();
  return new Response(body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

export async function systemStatus(): Promise<{
  configured: boolean;
  reachable: boolean;
  version?: string;
  serverName?: string;
  error?: string;
}> {
  if (!jellyfinReady()) return { configured: false, reachable: false, error: "not configured" };
  try {
    // Deliberately /System/Info and not /System/Info/Public: the public one
    // needs no key, so it cannot tell you the key is being rejected.
    const info = await request<{ Version?: string; ServerName?: string }>("GET", "System/Info");
    return { configured: true, reachable: true, version: info?.Version, serverName: info?.ServerName };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ask Jellyfin to rescan its libraries. This is what makes a freshly
 * downloaded file appear in the library — and therefore what lets a request
 * move on from `import_pending`.
 */
export async function refreshLibrary(): Promise<void> {
  await request<void>("POST", "Library/Refresh");
}
