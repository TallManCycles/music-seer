import { NextResponse } from "next/server";
import { search } from "@/lib/musicbrainz";
import * as db from "@/lib/db";
import type { MediaType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: MediaType[] = ["artist", "album", "track"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const type = (url.searchParams.get("type") ?? "album") as MediaType;

  if (!q) return NextResponse.json({ results: [] });
  if (!TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of ${TYPES.join(", ")}` }, { status: 400 });
  }

  try {
    const results = await search(q, type);
    const requested = new Map(
      db.listRequests().map((r) => [`${r.type}:${r.mbid}`, r] as const)
    );
    return NextResponse.json({
      results: results.map((r) => {
        const existing = requested.get(`${r.type}:${r.mbid}`);
        return {
          ...r,
          requestId: existing?.id,
          requestStatus: existing?.status,
        };
      }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "search failed" },
      { status: 502 }
    );
  }
}
