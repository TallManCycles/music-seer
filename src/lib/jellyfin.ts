import { jellyfinCredentials, jellyfinReady } from "./settings";
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
      // Jellyfin accepts this alongside the longer MediaBrowser Authorization
      // header; the API key is the whole of the auth.
      "X-Emby-Token": cfg.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new JellyfinError(
      `Jellyfin ${method} ${path} -> ${res.status} ${res.statusText}`,
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
    headers: { "X-Emby-Token": cfg.apiKey, Accept: "image/*" },
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
    // /System/Info/Public needs no key, so this also distinguishes "down" from
    // "bad API key".
    const info = await request<{ Version?: string; ServerName?: string }>(
      "GET",
      "System/Info/Public"
    );
    return { configured: true, reachable: true, version: info?.Version, serverName: info?.ServerName };
  } catch (err) {
    return { configured: true, reachable: false, error: err instanceof Error ? err.message : String(err) };
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
