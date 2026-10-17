import { config } from "./config";
import { localCharts, type LocalChart } from "./charts";
import * as db from "./db";
import * as jellyfin from "./jellyfin";
import {
  artistsByGenre,
  releaseGroupsForArtist,
  search as mbSearch,
} from "./musicbrainz";
import { jellyfinReady } from "./settings";
import type { SearchResult } from "./types";

/**
 * "What should I add next?" — answered from the library you already have rather
 * than a recommendation service: take the artists you own the most of, ask
 * MusicBrainz for their studio albums, and show the ones Jellyfin cannot see.
 *
 * The alternative (MusicBrainz genre/year browsing) is not used because it
 * suggests music you have no reason to want; "you own four albums by this
 * artist, here is the fifth" needs no taste model to be useful.
 *
 * MusicBrainz allows about one request per second, so the expensive part — a
 * name search and a discography browse per artist — is done by the background
 * scheduler (`scanArtists`) and accumulated in SQLite (`discover.pool`). A
 * request to the shelf is then just a read plus the two cheap charts, so it is
 * fast even on a cold cache or straight after a restart.
 */

export interface Suggestion {
  album: SearchResult;
  reason: string;
  requestId?: number;
  requestStatus?: string;
}

/** An artist you do not have, drawn from the genres your library leans on. */
export interface ArtistSuggestion {
  artist: SearchResult;
  reason: string;
  requestId?: number;
  requestStatus?: string;
}

/** A popular release you do not have, from ListenBrainz's sitewide chart. */
export interface ChartSuggestion {
  album: SearchResult;
  reason: string;
  listenCount: number;
  requestId?: number;
  requestStatus?: string;
}

export interface DiscoverResult {
  configured: boolean;
  error?: string;
  /** An actionable explanation when there is nothing to suggest. */
  note?: string;
  libraryAlbums: number;
  libraryArtists: number;
  suggestions: Suggestion[];
  newArtists: ArtistSuggestion[];
  /** Albums from this year or last by artists you own. */
  newReleases: Suggestion[];
  /** ListenBrainz's sitewide chart, minus anything you already have. */
  charts: ChartSuggestion[];
  /** Why the chart is missing, when it is. */
  chartsError?: string;
  /** Regional album chart (Apple), keyed by country. */
  localChart: LocalChart;
  /** The genres the suggestions were drawn from. */
  basedOn: string[];
}

const MAX_ARTISTS = 12;
/**
 * How many of the biggest collections to consider. The shelf browses a rotating
 * window of these rather than the same few every time: with a library of
 * hundreds of artists, always asking about the top four makes the shelf look
 * broken, and "the artist you own most of" is not the only thing worth
 * suggesting.
 */
const POOL_SIZE = 60;
const ALBUMS_PER_ARTIST = 25;
/** How many of the library's top genres to look for new artists in. */
const GENRES_FOR_DISCOVERY = 2;
const NEW_ARTIST_LIMIT = 20;
const NEW_RELEASE_LIMIT = 20;
const CHART_LIMIT = 30;
/** Regional chart entries to show. */
const LOCAL_CHART_LIMIT = 25;
/** ListenBrainz returns 25 by default; it will give up to 100. */
const CHART_FETCH = 50;
/**
 * Charts change hourly, so a few minutes of cache is plenty. This is about
 * resilience rather than speed: it stops every page load hammering ListenBrainz
 * (which rate limits), and it means a blip serves the last good chart instead of
 * an empty shelf.
 */
const CHART_TTL_MS = 5 * 60 * 1000;

/**
 * The MusicBrainz work is no longer cached in memory. It is accumulated in one
 * SQLite setting and refreshed in the background, so a cold start (including
 * after a restart) reads it instead of re-asking MusicBrainz for half a minute.
 */
const POOL_KEY = "discover.pool";
/** Keep the persisted blob small: oldest suggestions are dropped first. */
const MAX_POOL_ALBUMS = 400;
/** Recent releases are shown newest-first; this is a ceiling on the backlog. */
const MAX_POOL_RECENT = 60;

/** One missing album the shelf can offer, stored without request state. */
interface PoolAlbum {
  album: SearchResult;
  artistName: string;
  reason: string;
}

/**
 * Everything the expensive scan learns, persisted as one JSON blob. Request
 * state is deliberately absent: it is attached at read time (see
 * `suggestions`) so it can never go stale in here. The library identity is kept
 * too, so the charts can be filtered without re-listing the library on every
 * page load.
 */
interface DiscoverPool {
  updatedAt: string;
  /** Normalised artist names already scanned in this cycle. */
  scanned: string[];
  /** Missing albums from the artists scanned so far. */
  albums: PoolAlbum[];
  /** Missing releases from the last few years. */
  recent: PoolAlbum[];
  /** Genre weights accumulated from every scanned discography. */
  genres: Record<string, number>;
  /** Well-known artists in the library's top genres that it does not own. */
  newArtists: Array<{ artist: SearchResult; reason: string }>;
  /** Library identity, so the charts can be filtered on a plain read. */
  ownedNames: string[];
  ownedKeys: string[];
  libraryAlbums: number;
  libraryArtists: number;
  /** Artists in the current cycle that could not be matched on MusicBrainz. */
  unresolved: number;
}

let chartCache: { at: number; charts: ChartSuggestion[] } | null = null;
/** Serialises scans so the scheduler and a cold-start read cannot interleave. */
let scanning: Promise<void> | null = null;

/**
 * Called when credentials change so a new library is not served stale advice.
 * Nothing is cached in memory any more — request state is annotated at read
 * time and the library is re-checked on every background scan — so there is
 * nothing to drop. Kept for the call sites in requests.ts.
 */
export function invalidateSuggestions(): void {
  // No-op: see the comment above.
}

function artistOf(item: jellyfin.JellyfinItem): string {
  return (item.AlbumArtist ?? item.Artists?.[0] ?? "").trim();
}

/** Identity of an album for "do we already have it?" purposes. */
function albumKey(artist: string, title: string): string {
  return `${jellyfin.normalizeName(artist)}|${jellyfin.normalizeName(title)}`;
}

/**
 * Cover art through our own proxy, as a ready-to-use URL. The UI used to build
 * this itself and got it wrong for charts (which are keyed by release, not
 * release group), so the API hands out the finished URL instead.
 */
function proxiedCover(album: SearchResult): string | undefined {
  const id = album.releaseGroupMbid ?? album.mbid;
  return id ? `/api/cover?mbid=${encodeURIComponent(id)}&size=300` : undefined;
}

interface LibraryArtist {
  name: string;
  mbid?: string;
  albums: number;
}

function artistsFromLibrary(albums: jellyfin.JellyfinItem[]): {
  artists: LibraryArtist[];
  keys: Set<string>;
} {
  const byName = new Map<string, LibraryArtist>();
  const keys = new Set<string>();

  for (const album of albums) {
    const name = artistOf(album);
    if (!name) continue;
    keys.add(albumKey(name, album.Name));

    const normalized = jellyfin.normalizeName(name);
    const existing = byName.get(normalized) ?? { name, mbid: undefined, albums: 0 };
    existing.albums += 1;
    // Prefer an item that carries a MusicBrainz id, so we can browse exactly.
    existing.mbid = existing.mbid ?? jellyfin.musicBrainzArtistId(album);
    // And keep the longest artist name we have seen for a nicer label.
    if (name.length > existing.name.length) existing.name = name;
    byName.set(normalized, existing);
  }

  // Artists we can look up exactly come first, then the biggest collections.
  const artists = [...byName.values()].sort(
    (a, b) => Number(Boolean(b.mbid)) - Number(Boolean(a.mbid)) || b.albums - a.albums
  );
  return { artists, keys };
}

/**
 * The MusicBrainz artist id for a library artist.
 *
 * Jellyfin's MusicBrainz plugin is the reliable source, but plenty of libraries
 * have no provider ids at all (this one included), so fall back to searching
 * MusicBrainz by name. That needs to be strict: only an exact normalised name
 * match counts, because binding an artist to the wrong MusicBrainz entry
 * suggests the wrong discography entirely.
 */
async function resolveArtistMbid(artist: LibraryArtist): Promise<string | undefined> {
  if (artist.mbid) return artist.mbid;
  try {
    const results = await mbSearch(artist.name, "artist");
    const wanted = jellyfin.normalizeName(artist.name);
    const exact = results.find((r) => jellyfin.normalizeName(r.title) === wanted);
    return exact?.mbid;
  } catch {
    return undefined;
  }
}

/** The ListenBrainz sitewide chart. */
const LISTENBRAINZ = "https://api.listenbrainz.org/1";

interface LbRelease {
  release_name: string;
  release_mbid: string;
  artist_name: string;
  artist_mbids?: string[];
  caa_release_mbid?: string;
  listen_count: number;
}

/**
 * Chart releases from ListenBrainz, which is the only place to get a popularity
 * signal without an API key — MusicBrainz has none, and its search rank is not
 * the same thing.
 *
 * This is *global* listening, not personalised, so it is labelled as a chart
 * rather than presented as a recommendation, and anything by an artist already
 * in the library is dropped. One HTTP request, cached with the rest.
 */
async function chartSuggestions(
  ownedNames: Set<string>,
  limit: number
): Promise<{ charts: ChartSuggestion[]; error?: string }> {
  if (chartCache && Date.now() - chartCache.at < CHART_TTL_MS) {
    return { charts: chartCache.charts };
  }

  // One retry: a single blip should not cost the shelf, and this is a cheap
  // request next to the MusicBrainz work.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(
        `${LISTENBRAINZ}/stats/sitewide/releases?range=week&count=${CHART_FETCH}`,
        {
          headers: { Accept: "application/json", "User-Agent": config().userAgent },
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!res.ok) {
        if (attempt === 0) continue;
        return staleCharts(`ListenBrainz answered ${res.status}`);
      }
      const body = (await res.json()) as { payload?: { releases?: LbRelease[] } };

      const out: ChartSuggestion[] = [];
      const seen = new Set<string>();
      for (const release of body.payload?.releases ?? []) {
        if (!release.release_mbid || !release.release_name) continue;
        const artistKey = jellyfin.normalizeName(release.artist_name ?? "");
        if (!artistKey || ownedNames.has(artistKey)) continue;

        // ListenBrainz charts individual releases, so the same album appears
        // once per edition. Collapse those before showing anything.
        const key = `${artistKey}|${jellyfin.normalizeName(release.release_name)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          album: {
            type: "album",
            mbid: release.release_mbid,
            title: release.release_name,
            artist: release.artist_name,
            artistMbid: release.artist_mbids?.[0],
            // Charts are keyed by release, so the cover must be asked for as a
            // release — asking as a release group is a guaranteed 404.
            coverUrl: `/api/cover?release=${encodeURIComponent(
              release.caa_release_mbid || release.release_mbid
            )}&size=300`,
            subtitle: "Chart",
          },
          reason: `${release.listen_count.toLocaleString("en-AU")} listens this week`,
          listenCount: release.listen_count,
        });
        if (out.length >= limit) break;
      }
      chartCache = { at: Date.now(), charts: out };
      return { charts: out };
    } catch (err) {
      if (attempt === 1) {
        return staleCharts(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return staleCharts("no attempt succeeded");
}

/** The last good chart, or nothing, plus why it is stale. */
function staleCharts(reason: string): { charts: ChartSuggestion[]; error?: string } {
  if (chartCache) {
    return { charts: chartCache.charts, error: `showing the last chart (${reason})` };
  }
  return { charts: [], error: reason };
}

// --- the persisted pool ----------------------------------------------------

/** Read the pool, tolerating an absent or unreadable blob. */
function readPool(): DiscoverPool | null {
  const raw = db.getSetting(POOL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoverPool>;
    return {
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      scanned: parsed.scanned ?? [],
      albums: parsed.albums ?? [],
      recent: parsed.recent ?? [],
      genres: parsed.genres ?? {},
      newArtists: parsed.newArtists ?? [],
      ownedNames: parsed.ownedNames ?? [],
      ownedKeys: parsed.ownedKeys ?? [],
      libraryAlbums: parsed.libraryAlbums ?? 0,
      libraryArtists: parsed.libraryArtists ?? 0,
      unresolved: parsed.unresolved ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ask MusicBrainz about the next few library artists and fold the answers into
 * the persisted pool.
 *
 * This is the work that used to make GET /api/discover take half a minute: a
 * name search and a discography browse per artist, and MusicBrainz allows about
 * one request per second. The scheduler calls it every tick, so the pool fills
 * within seconds of boot and the route only ever reads it.
 *
 * It must never throw into the scheduler, and must return immediately when
 * Jellyfin is not configured (the e2e suite runs that way and must not hang).
 */
export async function scanArtists(budget = 3): Promise<void> {
  if (!jellyfinReady()) return;
  // A scan already in flight owns the pool; join it rather than racing it and
  // losing a write.
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      await scanOnce(budget);
    } catch (err) {
      // Keep the previous pool rather than losing a good shelf to a blip.
      console.error("[music-seer] discover scan failed:", err);
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

/** Add to a pool list, deduped by album MBID and capped oldest-first. */
function addPoolAlbum(list: PoolAlbum[], entry: PoolAlbum, cap: number): void {
  const idx = list.findIndex((e) => e.album.mbid === entry.album.mbid);
  if (idx !== -1) list.splice(idx, 1);
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
}

/** The "new artists" shelf, from the genres accumulated in the pool so far. */
async function refreshNewArtists(
  pool: DiscoverPool
): Promise<Array<{ artist: SearchResult; reason: string }>> {
  const owned = new Set(pool.ownedNames);
  const topGenres = [...Object.entries(pool.genres)]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GENRES_FOR_DISCOVERY)
    .map(([name]) => name);

  const out: Array<{ artist: SearchResult; reason: string }> = [];
  const seen = new Set<string>();
  for (const genre of topGenres) {
    if (out.length >= NEW_ARTIST_LIMIT) break;
    let found: SearchResult[];
    try {
      // Ask for more than we need: artists already in the library are filtered
      // out afterwards, and the genre search is only one request either way.
      found = await artistsByGenre(genre, 40);
    } catch {
      continue;
    }
    for (const candidate of found) {
      if (out.length >= NEW_ARTIST_LIMIT) break;
      const key = jellyfin.normalizeName(candidate.title);
      if (!key || owned.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ artist: candidate, reason: `You listen to a lot of ${genre}` });
    }
  }
  return out;
}

async function scanOnce(budget: number): Promise<void> {
  const albums = await jellyfin.listAlbums({ limit: 1000 });
  const { artists, keys } = artistsFromLibrary(albums);

  const pool: DiscoverPool = readPool() ?? {
    updatedAt: new Date(0).toISOString(),
    scanned: [],
    albums: [],
    recent: [],
    genres: {},
    newArtists: [],
    ownedNames: [],
    ownedKeys: [],
    libraryAlbums: 0,
    libraryArtists: 0,
    unresolved: 0,
  };

  // The library snapshot is cheap and always current, so refresh it every scan.
  pool.libraryAlbums = albums.length;
  pool.libraryArtists = artists.length;
  pool.ownedNames = [...new Set(artists.map((a) => jellyfin.normalizeName(a.name)))];
  pool.ownedKeys = [...keys];

  // Anything now owned is no longer a suggestion. This is what makes a
  // completed request leave the shelf, without re-scanning the artist.
  const isOwned = (entry: PoolAlbum) =>
    keys.has(albumKey(entry.album.artist || entry.artistName, entry.album.title)) ||
    keys.has(albumKey(entry.artistName, entry.album.title));
  pool.albums = pool.albums.filter((entry) => !isOwned(entry));
  pool.recent = pool.recent.filter((entry) => !isOwned(entry));

  const window = artists.slice(0, POOL_SIZE);
  const scanned = new Set(pool.scanned);
  let candidates = window.filter((a) => !scanned.has(jellyfin.normalizeName(a.name)));
  if (candidates.length === 0 && window.length > 0) {
    // The cycle is complete: start again so new releases and newly added
    // library artists get picked up.
    pool.scanned = [];
    pool.unresolved = 0;
    candidates = window;
  }

  const batch = candidates.slice(0, Math.max(0, budget));

  for (const artist of batch) {
    const normalized = jellyfin.normalizeName(artist.name);
    const mbid = await resolveArtistMbid(artist);
    if (!mbid) {
      // Counted so the shelf can explain an empty result, and recorded so the
      // cycle still advances rather than retrying the same artist forever.
      pool.unresolved += 1;
      pool.scanned.push(normalized);
      continue;
    }

    let discography: Awaited<ReturnType<typeof releaseGroupsForArtist>>;
    try {
      discography = await releaseGroupsForArtist(mbid, ALBUMS_PER_ARTIST);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A 404 means MusicBrainz has no such artist id — a stale or merged MBID
      // in the library. That is not an outage, so skip it quietly.
      if (!/MusicBrainz 404/.test(message)) {
        console.error(`[music-seer] discography for ${artist.name} failed:`, message);
      }
      pool.scanned.push(normalized);
      continue;
    }

    // Genres come from the discography call itself, so the taste profile is
    // free. Weighted by how many of the artist's albums carry each genre.
    for (const genre of discography.genres) {
      pool.genres[genre.name] = (pool.genres[genre.name] ?? 0) + genre.count;
    }

    const missing = discography.albums.filter((album) => {
      const credited = album.artist || artist.name;
      return (
        !keys.has(albumKey(credited, album.title)) &&
        !keys.has(albumKey(artist.name, album.title))
      );
    });

    const reason =
      artist.albums === 1
        ? `You have 1 album by ${artist.name}`
        : `You have ${artist.albums} albums by ${artist.name}`;

    for (const album of missing) {
      // Belt and braces: a missing credit must never reach a request, so fall
      // back to the artist we browsed.
      const credited = { ...album, artist: album.artist || artist.name };
      const entry: PoolAlbum = {
        album: { ...credited, coverUrl: proxiedCover(credited) },
        artistName: artist.name,
        reason,
      };
      addPoolAlbum(pool.albums, entry, MAX_POOL_ALBUMS);

      // Albums from the last few years that the library does not have: a
      // release you have not caught up with yet. The dates arrive with the
      // discography, so this costs nothing extra.
      const year = Number(album.year);
      if (Number.isFinite(year) && year >= new Date().getFullYear() - 2) {
        addPoolAlbum(
          pool.recent,
          { ...entry, reason: `New in ${year} from ${artist.name}` },
          MAX_POOL_RECENT
        );
      }
    }

    pool.scanned.push(normalized);
  }

  // Refresh the "new artists" shelf from the genres accumulated so far. Two
  // requests; the genre search is the only popularity signal available.
  pool.newArtists = await refreshNewArtists(pool);

  pool.updatedAt = new Date().toISOString();
  db.setSetting(POOL_KEY, JSON.stringify(pool));
}

/**
 * A rotating window over the accumulated albums. The offset moves once an hour
 * so the shelf varies without any extra work, and wraps around the whole pool.
 */
function rotate(albums: PoolAlbum[], limit: number): PoolAlbum[] {
  if (albums.length === 0 || limit <= 0) return [];
  const size = Math.min(limit, albums.length);
  const offset = (Math.floor(Date.now() / 3600000) * limit) % albums.length;
  return [...albums.slice(offset), ...albums.slice(0, offset)].slice(0, size);
}

export async function suggestions(limit = 24): Promise<DiscoverResult> {
  if (!jellyfinReady()) {
    return {
      configured: false,
      libraryAlbums: 0,
      libraryArtists: 0,
      suggestions: [],
      newArtists: [],
      newReleases: [],
      charts: [],
      localChart: { region: "", regionName: "", entries: [] },
      basedOn: [],
    };
  }

  // Fresh install: do the expensive scan once, then read it back. Every later
  // load — including after a restart — finds the pool already in SQLite.
  let pool = readPool();
  if (!pool) {
    await scanArtists(MAX_ARTISTS);
    pool = readPool();
  }

  // Request state is attached here, not stored, so it is never stale.
  const requested = new Map(
    db.listRequests().map((r) => [r.mbid, { id: r.id, status: r.status }] as const)
  );

  if (!pool) {
    // The scan could not run (MusicBrainz down, or Jellyfin unreachable). Serve
    // an empty shelf with an explanation rather than a 25-second hang.
    const [charts, localChart] = await Promise.all([
      chartSuggestions(new Set<string>(), CHART_LIMIT),
      localCharts(LOCAL_CHART_LIMIT, () => false, new Map()),
    ]);
    return {
      configured: true,
      note: "Suggestions are still being built — check back in a few minutes.",
      libraryAlbums: 0,
      libraryArtists: 0,
      suggestions: [],
      newArtists: [],
      newReleases: [],
      charts: charts.charts,
      chartsError: charts.error,
      localChart,
      basedOn: [],
    };
  }

  const annotate = (entry: PoolAlbum): Suggestion => {
    const existing = requested.get(entry.album.mbid);
    return {
      album: entry.album,
      reason: entry.reason,
      requestId: existing?.id,
      requestStatus: existing?.status,
    };
  };

  const out = rotate(pool.albums, limit).map(annotate);

  const newReleases = [...pool.recent]
    .sort((a, b) => Number(b.album.year ?? 0) - Number(a.album.year ?? 0))
    .slice(0, NEW_RELEASE_LIMIT)
    .map(annotate);

  const newArtists: ArtistSuggestion[] = pool.newArtists.map((entry) => {
    const existing = requested.get(entry.artist.mbid);
    return {
      artist: entry.artist,
      reason: entry.reason,
      requestId: existing?.id,
      requestStatus: existing?.status,
    };
  });

  const basedOn = [...Object.entries(pool.genres)]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GENRES_FOR_DISCOVERY)
    .map(([name]) => name);

  // The two charts are the only live work left, and they are one cheap request
  // each — fetched fresh, in parallel, so a blip cannot be baked in.
  const ownedKeys = new Set(pool.ownedKeys);
  const [charts, localChart] = await Promise.all([
    chartSuggestions(new Set(pool.ownedNames), CHART_LIMIT),
    localCharts(
      LOCAL_CHART_LIMIT,
      (artist, title) => ownedKeys.has(albumKey(artist, title)),
      requested
    ),
  ]);

  const value: DiscoverResult = {
    configured: true,
    libraryAlbums: pool.libraryAlbums,
    libraryArtists: pool.libraryArtists,
    suggestions: out,
    newArtists,
    newReleases,
    charts: charts.charts,
    chartsError: charts.error,
    localChart,
    basedOn,
  };

  if (pool.albums.length === 0 && pool.newArtists.length === 0 && pool.unresolved > 0) {
    // Empty for a reason the user can act on, so say so rather than showing a
    // blank shelf.
    value.note =
      "None of the artists in your library could be matched on MusicBrainz by name, so there is nothing to compare against. Turning on MusicBrainz metadata in Jellyfin makes this exact rather than a name guess.";
  }

  return value;
}
