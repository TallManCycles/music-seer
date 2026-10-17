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
 * MusicBrainz allows about one request per second, so this is deliberately
 * capped at a handful of artists and cached in memory.
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
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: {
  at: number;
  value: DiscoverResult;
  ownedNames: string[];
  ownedKeys: string[];
  requested: Array<[string, { id: number; status: string }]>;
} | null = null;
let chartCache: { at: number; charts: ChartSuggestion[] } | null = null;

/** Called when credentials change so a new library is not served stale advice. */
export function invalidateSuggestions(): void {
  cache = null;
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
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    // The MusicBrainz work is what costs 20-odd seconds, so that is what gets
    // cached. Both charts are one cheap request each and change hourly, so they
    // are fetched fresh every time — which also means a blip cannot get baked
    // into the cache for half an hour (it did, once, for the global chart).
    const [charts, localChart] = await Promise.all([
      chartSuggestions(new Set(cache.ownedNames), CHART_LIMIT),
      localCharts(
        LOCAL_CHART_LIMIT,
        (artist, title) => cache!.ownedKeys.includes(albumKey(artist, title)),
        new Map(cache.requested)
      ),
    ]);
    return { ...cache.value, charts: charts.charts, chartsError: charts.error, localChart };
  }

  const albums = await jellyfin.listAlbums({ limit: 1000 });
  const { artists, keys } = artistsFromLibrary(albums);
  const windowIndex = Math.floor(Date.now() / CACHE_TTL_MS);

  // Artists with an id straight from Jellyfin come first, then the biggest
  // collections; the rest are resolved by name, one MusicBrainz call each.
  //
  // The window rotates every cache period. Always browsing the same four
  // biggest collections made the shelf look broken in a library of hundreds of
  // artists, and "the artist you own most of" is not the only thing worth
  // suggesting.
  const pool = artists.slice(0, POOL_SIZE);
  const offset = pool.length ? (windowIndex * MAX_ARTISTS) % pool.length : 0;
  const candidates = [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, MAX_ARTISTS);

  const pools: Suggestion[][] = [];
  const genreWeights = new Map<string, number>();
  const recent: Array<{ album: SearchResult; artistName: string; year: number }> = [];
  let failures = 0;
  let unresolved = 0;

  for (const artist of candidates) {
    const mbid = await resolveArtistMbid(artist);
    if (!mbid) {
      unresolved += 1;
      continue;
    }

    let discography: Awaited<ReturnType<typeof releaseGroupsForArtist>>;
    try {
      discography = await releaseGroupsForArtist(mbid, ALBUMS_PER_ARTIST);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A 404 means MusicBrainz has no such artist id — a stale or merged MBID
      // in the library. That is not an outage, so skip it quietly rather than
      // failing the whole shelf.
      if (!/MusicBrainz 404/.test(message)) failures += 1;
      continue;
    }

    // Genres come from the discography call itself, so the taste profile is
    // free. Weighted by how many of the artist's albums carry each genre.
    for (const genre of discography.genres) {
      genreWeights.set(genre.name, (genreWeights.get(genre.name) ?? 0) + genre.count);
    }

    const missing = discography.albums.filter((album) => {
      const credited = album.artist || artist.name;
      return !keys.has(albumKey(credited, album.title)) && !keys.has(albumKey(artist.name, album.title));
    });

    // Albums from the last few years that the library does not have: a release
    // you have not caught up with yet. The dates arrive with the discography, so
    // this costs nothing extra — but the count is bounded by what your artists
    // have actually put out, which is why this shelf is often the shortest.
    for (const album of missing) {
      const year = Number(album.year);
      if (Number.isFinite(year) && year >= new Date().getFullYear() - 2) {
        recent.push({ album, artistName: artist.name, year });
      }
    }

    if (missing.length === 0) continue;

    const requested = new Map(db.listRequests().map((r) => [r.mbid, r] as const));
    pools.push(
      missing.map((album) => {
        const existing = requested.get(album.mbid);
        // Belt and braces: a missing credit must never reach a request, so fall
        // back to the artist we browsed.
        const credited = { ...album, artist: album.artist || artist.name };
        return {
          album: { ...credited, coverUrl: proxiedCover(credited) },
          reason:
            artist.albums === 1
              ? `You have 1 album by ${artist.name}`
              : `You have ${artist.albums} albums by ${artist.name}`,
          requestId: existing?.id,
          requestStatus: existing?.status,
        };
      })
    );
  }

  // Round-robin so one prolific artist cannot fill the whole shelf.
  const out: Suggestion[] = [];
  for (let depth = 0; out.length < limit; depth += 1) {
    let added = false;
    for (const pool of pools) {
      const next = pool[depth];
      if (!next) continue;
      out.push(next);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }

  // --- new artists ---------------------------------------------------------
  // The genres this library leans on, then well-known groups in those genres
  // that the library does not already have. MusicBrainz ranks its search by
  // relevance, which is the only popularity signal available — so this is
  // presented with its reason rather than as a recommendation engine.
  const ownedNames = new Set(artists.map((a) => jellyfin.normalizeName(a.name)));
  const topGenres = [...genreWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, GENRES_FOR_DISCOVERY)
    .map(([name]) => name);

  const requested = new Map(db.listRequests().map((r) => [r.mbid, r] as const));
  const newArtists: ArtistSuggestion[] = [];
  const seenArtists = new Set<string>();

  for (const genre of topGenres) {
    if (newArtists.length >= NEW_ARTIST_LIMIT) break;
    let found: SearchResult[];
    try {
      // Ask for more than we need: artists already in the library are filtered
      // out afterwards, and the genre search is only one request either way.
      found = await artistsByGenre(genre, 40);
    } catch {
      continue;
    }
    for (const candidate of found) {
      if (newArtists.length >= NEW_ARTIST_LIMIT) break;
      const key = jellyfin.normalizeName(candidate.title);
      if (!key || ownedNames.has(key) || seenArtists.has(key)) continue;
      seenArtists.add(key);
      const existing = requested.get(candidate.mbid);
      newArtists.push({
        artist: candidate,
        reason: `You listen to a lot of ${genre}`,
        requestId: existing?.id,
        requestStatus: existing?.status,
      });
    }
  }

  const chartResult = await chartSuggestions(ownedNames, CHART_LIMIT);

  const value: DiscoverResult = {
    configured: true,
    libraryAlbums: albums.length,
    libraryArtists: artists.length,
    suggestions: out,
    newArtists,
    newReleases: recent
      .sort((a, b) => b.year - a.year)
      .slice(0, NEW_RELEASE_LIMIT)
      .map((entry) => {
        const existing = requested.get(entry.album.mbid);
        return {
          album: { ...entry.album, artist: entry.album.artist || entry.artistName, coverUrl: proxiedCover(entry.album) },
          reason: `New in ${entry.year} from ${entry.artistName}`,
          requestId: existing?.id,
          requestStatus: existing?.status,
        };
      }),
    charts: chartResult.charts,
    chartsError: chartResult.error,
    localChart: await localCharts(
      LOCAL_CHART_LIMIT,
      (artist, title) => keys.has(albumKey(artist, title)),
      requested
    ),
    basedOn: topGenres,
  };
  if (out.length === 0 && unresolved > 0 && unresolved === candidates.length) {
    // Empty for a reason the user can act on, so say so rather than showing a
    // blank shelf.
    value.note =
      "None of the artists in your library could be matched on MusicBrainz by name, so there is nothing to compare against. Turning on MusicBrainz metadata in Jellyfin makes this exact rather than a name guess.";
  }
  // Only cache a result that is not simply "MusicBrainz was down".
  if (!(failures > 0 && failures === candidates.length && out.length === 0)) {
    cache = {
    at: Date.now(),
    value,
    ownedNames: [...ownedNames],
    ownedKeys: [...keys],
    requested: [...requested.entries()].map(([k, v]) => [k, { id: v.id, status: v.status }]),
  };
  } else {
    value.error = "Could not reach MusicBrainz to build suggestions";
  }
  return value;
}
