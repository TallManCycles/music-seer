import { NextResponse } from "next/server";
import { z } from "zod";
import { createRequest } from "@/lib/requests";
import * as db from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  type: z.enum(["artist", "album", "track"]),
  mbid: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().default(""),
  artistMbid: z.string().optional(),
  releaseGroupMbid: z.string().optional(),
  year: z.string().optional(),
  coverUrl: z.string().optional(),
  autoFallback: z.boolean().optional(),
  fallbackAfterMinutes: z.number().int().min(0).optional(),
});

export async function GET() {
  return NextResponse.json({ requests: db.listRequests() });
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const outcome = await createRequest(parsed.data);
    return NextResponse.json(
      {
        request: db.getRequest(outcome.request.id),
        duplicate: outcome.duplicate,
      },
      { status: outcome.duplicate ? 200 : 201 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not create request" },
      { status: 500 }
    );
  }
}
