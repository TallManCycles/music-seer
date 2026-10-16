import { NextResponse } from "next/server";
import { suggestions } from "@/lib/discover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What to add next, based on the artists already in the library.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 24) || 24, 1), 60);

  try {
    return NextResponse.json(await suggestions(limit));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not build suggestions" },
      { status: 502 }
    );
  }
}
