import { config } from "./config";
import type { MediaType, SearchResult } from "./types";
const MB = "https://musicbrainz.org/ws/2";
const COVER_ART = "https://coverartarchive.org";
const MIN_INTERVAL_MS = 1100; // MusicBrainz allows ~1 request/second.

// --- polite, serialized rate limiter ---------------------------------------

let lastCall = 0;
let gate: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquire(): Promise<void> {
  let release!: () => void;
  const prev = gate;
  gate = new Promise<void>((res) => {
    release = res;
  });
  await prev;
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  release();
}

// --- HTTP ------------------------------------------------------------------

const LUCENE_SPECIAL = /((?:[+\-!(){}[\]^"~*?:\\/])|&&|\|\|)/g;

/**
 * Escape Lucene syntax. Note the outer group: without it the `&&`/`||`
 * branches have no capture group, so the replacement would silently become a
 * lone backslash and mangle the query.
 */
function escapeLucene(q: string): string {
  return q.replace(LUCENE_SPECIAL, "\\$1");
}

async function mbFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${MB}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let attempt = 0;
  for (;;) {
    await acquire();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": config().userAgent,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      // Transient DNS/connect hiccups are common against MusicBrainz.
      if (attempt < 2) {
        attempt += 1;
        await sleep(600 * attempt);
        continue;
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(
        `MusicBrainz request failed for ${url.pathname}: ${
          cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))
        }`
      );
    }
    if (res.status === 503 && attempt < 3) {
      attempt += 1;
      await sleep(1000 * attempt);
      continue;
    }
    if (!res.ok) {
      throw new Error(`MusicBrainz ${res.status} ${res.statusText} for ${url.pathname}`);
    }
    return (await res.json()) as T;
  }
}

// --- response shapes -------------------------------------------------------

interface ArtistCredit {
  name?: string;
  artist?: { id: string; name: string };
}

interface MBArtist {
  id: string;
  name: string;
  "sort-name"?: string;
  "life-span"?: { begin?: string };
  disambiguation?: string;
}

interface MBReleaseGroup {
  id: string;
  title: string;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "first-release-date"?: string;
  "artist-credit"?: ArtistCredit[];
  "release-count"?: number;
}

interface MBRecording {
  id: string;
  title: string;
  "artist-credit"?: ArtistCredit[];
  releases?: Array<{
    id: string;
    title: string;
    date?: string;
    "release-group"?: { id: string; "primary-type"?: string };
  }>;
}

function creditName(credits: ArtistCredit[] | undefined): string {
  if (!credits?.length) return "";
  return credits
    .map((c) => c.name ?? c.artist?.name ?? "")
    .join(" & ")
    .trim();
}

function firstArtistMbid(credits: ArtistCredit[] | undefined): string | undefined {
  return credits?.find((c) => c.artist?.id)?.artist?.id;
}

function yearOf(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})/.exec(date);
  return m ? m[1] : undefined;
}

export function coverArtUrl(releaseGroupMbid: string | undefined, size = 250): string | undefined {
  if (!releaseGroupMbid) return undefined;
  return `${COVER_ART}/release-group/${releaseGroupMbid}/front-${size}`;
}

/**
 * An artist's studio albums, by MBID (the browse endpoint, not search — so the
 * results really are that artist's albums). Used to suggest what is missing
 * from a library that already has the artist.
 */
export async function releaseGroupsForArtist(artistMbid: string, limit = 25): Promise<SearchResult[]> {
  if (!artistMbid) return [];
  const data = await mbFetch<{ "release-groups": MBReleaseGroup[] }>("release-group", {
    artist: artistMbid,
    type: "album",
    // The browse endpoint does not credit artists unless asked, and an empty
    // artist name propagates all the way into the request.
    inc: "artist-credits",
    limit: String(limit),
    fmt: "json",
  });

  return (data["release-groups"] ?? [])
    .map((rg) => ({
      type: "album" as const,
      mbid: rg.id,
      releaseGroupMbid: rg.id,
      title: rg.title,
      artist: creditName(rg["artist-credit"]),
      artistMbid: firstArtistMbid(rg["artist-credit"]) ?? artistMbid,
      year: yearOf(rg["first-release-date"]),
      coverUrl: coverArtUrl(rg.id),
      subtitle: [rg["primary-type"], ...(rg["secondary-types"] ?? [])].filter(Boolean).join(" · "),
    }))
    .sort((a, b) => (b.year ?? "").localeCompare(a.year ?? ""));
}

export async function search(query: string, type: MediaType): Promise<SearchResult[]> {
  const q = escapeLucene(query.trim());
  if (!q) return [];

  switch (type) {
    case "artist":
      return searchArtists(q);
    case "album":
      return searchAlbums(q);
    case "track":
      return searchTracks(q);
  }
}

async function searchArtists(q: string): Promise<SearchResult[]> {
  const data = await mbFetch<{ artists: MBArtist[] }>("artist", {
    query: q,
    limit: "25",
    fmt: "json",
  });
  return (data.artists ?? []).map((a) => ({
    type: "artist" as const,
    mbid: a.id,
    title: a.name,
    artist: "",
    artistMbid: a.id,
    year: yearOf(a["life-span"]?.begin),
    subtitle: ["Artist", a.disambiguation].filter(Boolean).join(" · "),
  }));
}

async function searchAlbums(q: string): Promise<SearchResult[]> {
  const data = await mbFetch<{ "release-groups": MBReleaseGroup[] }>("release-group", {
    query: q,
    limit: "25",
    fmt: "json",
  });
  return (data["release-groups"] ?? []).map((rg) => ({
    type: "album" as const,
    mbid: rg.id,
    releaseGroupMbid: rg.id,
    title: rg.title,
    artist: creditName(rg["artist-credit"]),
    artistMbid: firstArtistMbid(rg["artist-credit"]),
    year: yearOf(rg["first-release-date"]),
    coverUrl: coverArtUrl(rg.id),
    subtitle: [rg["primary-type"], ...(rg["secondary-types"] ?? [])]
      .filter(Boolean)
      .join(" · "),
  }));
}

async function searchTracks(q: string): Promise<SearchResult[]> {
  const data = await mbFetch<{ recordings: MBRecording[] }>("recording", {
    query: q,
    limit: "25",
    fmt: "json",
  });
  return (data.recordings ?? []).map((rec) => {
    // Prefer an album release group; singles/compilations are the fallback.
    const releases = rec.releases ?? [];
    const album =
      releases.find((r) => r["release-group"]?.["primary-type"] === "Album") ??
      releases[0];
    const rgId = album?.["release-group"]?.id;
    return {
      type: "track" as const,
      mbid: rec.id,
      releaseGroupMbid: rgId,
      title: rec.title,
      artist: creditName(rec["artist-credit"]),
      artistMbid: firstArtistMbid(rec["artist-credit"]),
      albumTitle: album?.title,
      year: yearOf(album?.date ?? releases[0]?.date),
      coverUrl: coverArtUrl(rgId),
      subtitle: [album?.title, yearOf(album?.date)].filter(Boolean).join(" · "),
    };
  });
}

/**
 * Track requests need an album to hand to Lidarr. Search results usually carry
 * the release group already; when they don't, fetch the recording directly.
 */
export async function releaseGroupForRecording(
  recordingMbid: string
): Promise<{ releaseGroupMbid?: string; albumTitle?: string; artist?: string; artistMbid?: string }> {
  const rec = await mbFetch<MBRecording & { "artist-credit"?: ArtistCredit[] }>(
    `recording/${recordingMbid}`,
    { inc: "releases+release-groups+artist-credits", fmt: "json" }
  );
  const releases = rec.releases ?? [];
  const album =
    releases.find((r) => r["release-group"]?.["primary-type"] === "Album") ?? releases[0];
  return {
    releaseGroupMbid: album?.["release-group"]?.id,
    albumTitle: album?.title,
    artist: creditName(rec["artist-credit"]),
    artistMbid: firstArtistMbid(rec["artist-credit"]),
  };
}
