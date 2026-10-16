import { NextResponse } from "next/server";
import * as jellyfin from "@/lib/jellyfin";
import { jellyfinReady } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The albums actually in the library, for the browse UI. Cover art is served
 * through /api/library/cover so the API key stays on the server.
 */
export async function GET(req: Request) {
  if (!jellyfinReady()) {
    return NextResponse.json({
      configured: false,
      albums: [],
      total: 0,
      needsSetup: true,
    });
  }

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 1000);

  try {
    const items = await jellyfin.listAlbums({ limit });
    return NextResponse.json({
      configured: true,
      total: items.length,
      albums: items.map((item) => ({
        id: item.Id,
        title: item.Name,
        artist: item.AlbumArtist ?? item.Artists?.[0] ?? "",
        year: item.ProductionYear,
        hasArt: Boolean(item.ImageTags?.Primary),
        coverUrl: `/api/library/cover?id=${encodeURIComponent(item.Id)}`,
        artistMbid: jellyfin.musicBrainzArtistId(item),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { configured: true, albums: [], error: err instanceof Error ? err.message : "library unavailable" },
      { status: 502 }
    );
  }
}
