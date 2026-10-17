import * as db from "./db";
import * as jellyfin from "./jellyfin";
import { artistsByGenre, releaseGroupsForArtist, search as mbSearch } from "./musicbrainz";
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

export interface DiscoverResult {
  configured: boolean;
  error?: string;
  /** An actionable explanation when there is nothing to suggest. */
  note?: string;
  libraryAlbums: number;
  libraryArtists: number;
  suggestions: Suggestion[];
  newArtists: ArtistSuggestion[];
  /** The genres the suggestions were drawn from. */
  basedOn: string[];
}

const MAX_ARTISTS = 4;
const ALBUMS_PER_ARTIST = 25;
/** How many of the library's top genres to look for new artists in. */
const GENRES_FOR_DISCOVERY = 2;
const NEW_ARTIST_LIMIT = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: { at: number; value: DiscoverResult } | null = null;

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

export async function suggestions(limit = 24): Promise<DiscoverResult> {
  if (!jellyfinReady()) {
    return {
      configured: false,
      libraryAlbums: 0,
      libraryArtists: 0,
      suggestions: [],
      newArtists: [],
      basedOn: [],
    };
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const albums = await jellyfin.listAlbums({ limit: 1000 });
  const { artists, keys } = artistsFromLibrary(albums);

  // Artists with an id straight from Jellyfin come first, then the biggest
  // collections; the rest are resolved by name, one MusicBrainz call each.
  const candidates = artists.slice(0, MAX_ARTISTS);

  const pools: Suggestion[][] = [];
  const genreWeights = new Map<string, number>();
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
    if (missing.length === 0) continue;

    const requested = new Map(db.listRequests().map((r) => [r.mbid, r] as const));
    pools.push(
      missing.map((album) => {
        const existing = requested.get(album.mbid);
        // Belt and braces: a missing credit must never reach a request, so fall
        // back to the artist we browsed.
        const credited = { ...album, artist: album.artist || artist.name };
        return {
          album: credited,
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
      found = await artistsByGenre(genre, 20);
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

  const value: DiscoverResult = {
    configured: true,
    libraryAlbums: albums.length,
    libraryArtists: artists.length,
    suggestions: out,
    newArtists,
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
    cache = { at: Date.now(), value };
  } else {
    value.error = "Could not reach MusicBrainz to build suggestions";
  }
  return value;
}
