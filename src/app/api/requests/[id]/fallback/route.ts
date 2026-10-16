import { NextResponse } from "next/server";
import { z } from "zod";
import * as db from "@/lib/db";
import { forceFallback } from "@/lib/requests";
import { validateSource } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  /** Optional explicit URL or `ytsearchN:` query to hand to yt-dlp. */
  source: z.string().optional(),
});

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const requestId = Number(id);
  if (!db.getRequest(requestId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  let source: string | undefined;
  if (parsed.success && parsed.data.source !== undefined) {
    const check = validateSource(parsed.data.source);
    if (!check.ok) {
      return NextResponse.json({ error: "invalid source", reason: check.reason }, { status: 400 });
    }
    source = check.source;
  }

  const request = await forceFallback(requestId, source);
  return NextResponse.json({ request });
}
