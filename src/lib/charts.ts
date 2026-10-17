import { config } from "./config";
import type { SearchResult } from "./types";

/**
 * Regional album charts, from Apple's public marketing feed.
 *
 * Chosen because it needs no API key and is genuinely regional: the ListenBrainz
 * chart the app already uses is global only (it has no country dimension), so it
 * cannot answer "what is charting in Australia".
 *
 * The feed gives no MusicBrainz identifiers, so entries cannot be requested
 * as-is — `resolveChartEntry` in requests.ts looks the release group up by name
 * when someone asks for one.
 */

const APPLE = "https://rss.marketingtools.apple.com/api/v2";

const REGION_NAMES: Record<string, string> = {
  au: "Australia",
  nz: "New Zealand",
  gb: "United Kingdom",
  us: "United States",
  ca: "Canada",
  ie: "Ireland",
  de: "Germany",
  fr: "France",
  jp: "Japan",
  se: "Sweden",
  nl: "Netherlands",
  in: "India",
  br: "Brazil",
};

export function regionName(code: string): string {
  const key = code.trim().toLowerCase();
  return REGION_NAMES[key] ?? key.toUpperCase();
}

interface AppleChartEntry {
  id: string;
  name: string;
  artistName: string;
  artworkUrl100?: string;
  url?: string;
  releaseDate?: string;
  genres?: Array<{ name: string }>;
}

export interface ChartEntry {
  album: SearchResult;
  /** Apple's chart position, 1-based. */
  rank: number;
  requestId?: number;
  requestStatus?: string;
}

export interface LocalChart {
  region: string;
  regionName: string;
  updated?: string;
  entries: ChartEntry[];
  error?: string;
}

/** Apple serves 100x100 thumbnails; the same asset scales. */
function biggerArtwork(url: string | undefined, size = 300): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${size}x${size}bb.$1`);
}

export async function localCharts(
  limit: number,
  isOwned: (artist: string, title: string) => boolean,
  requested: Map<string, { id: number; status: string }>
): Promise<LocalChart> {
  const region = (process.env.MUSICSEER_CHART_REGION ?? "au").trim().toLowerCase() || "au";
  const base: LocalChart = { region, regionName: regionName(region), entries: [] };

  if (localCache && Date.now() - localCache.at < CHART_TTL_MS) return localCache.chart;

  // Shorter than the other clients on purpose: this is a third-party feed, and a
  // failure should cost seconds, not the page load. A failed fetch serves the
  // last good chart rather than an empty shelf.
  try {
    const res = await fetch(`${APPLE}/${region}/music/most-played/${Math.max(limit * 2, 50)}/albums.json`, {
      headers: { Accept: "application/json", "User-Agent": config().userAgent },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return stale(`Apple charts answered ${res.status}`, base);

    const body = (await res.json()) as {
      feed?: { updated?: string; results?: AppleChartEntry[] };
    };

    const entries: ChartEntry[] = [];
    let rank = 0;
    for (const item of body.feed?.results ?? []) {
      rank += 1;
      if (!item.name || !item.artistName) continue;
      // Anything already in the library is not a suggestion.
      if (isOwned(item.artistName, item.name)) continue;

      const key = `chart:${item.id}`;
      const existing = requested.get(key);
      entries.push({
        album: {
          type: "album",
          // Not a MusicBrainz id: it only has to be stable and unique so a
          // request is recognised as a duplicate. The MusicBrainz release group
          // is looked up by name when the request is made.
          mbid: key,
          title: item.name,
          artist: item.artistName,
          year: item.releaseDate?.slice(0, 4),
          coverUrl: biggerArtwork(item.artworkUrl100),
          subtitle: item.genres?.[0]?.name ?? "Chart",
        },
        rank,
        requestId: existing?.id,
        requestStatus: existing?.status,
      });
      if (entries.length >= limit) break;
    }

    const chart: LocalChart = {
      region,
      regionName: regionName(region),
      updated: body.feed?.updated,
      entries,
    };
    localCache = { at: Date.now(), chart };
    return chart;
  } catch (err) {
    return stale(err instanceof Error ? err.message : String(err), base);
  }
}

let localCache: { at: number; chart: LocalChart } | null = null;

/** Five minutes of cache, matching the global chart. */
const CHART_TTL_MS = 5 * 60 * 1000;

/** The last good regional chart, or nothing, plus why it is stale. */
function stale(reason: string, base: LocalChart): LocalChart {
  if (localCache) return { ...localCache.chart, error: `showing the last chart (${reason})` };
  return { ...base, error: reason };
}

/** True for a MusicBrainz uuid; chart ids are deliberately not uuids. */
export function isMusicBrainzId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
