import { coverArtUrl } from "@/lib/musicbrainz";

export const runtime = "nodejs";

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250">
  <rect width="250" height="250" fill="#1c1c27"/>
  <g fill="none" stroke="#34344a" stroke-width="6">
    <circle cx="125" cy="125" r="62"/>
    <circle cx="125" cy="125" r="18" fill="#34344a"/>
  </g>
</svg>`;

/**
 * Proxies Cover Art Archive images so the browser never hits a cold, slow
 * archive.org redirect, and so we can cache the result ourselves.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mbid = url.searchParams.get("mbid");
  const size = Number(url.searchParams.get("size") ?? 250);

  if (!mbid || !/^[0-9a-f-]{36}$/i.test(mbid)) {
    return svg(400);
  }

  const target = coverArtUrl(mbid, Number.isFinite(size) ? size : 250);
  if (!target) return svg(400);

  try {
    const res = await fetch(target, {
      headers: { Accept: "image/*", "User-Agent": "music-seer/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return svg(404);
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return svg(504);
  }
}

function svg(status: number) {
  return new Response(PLACEHOLDER, {
    status,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=600",
    },
  });
}
