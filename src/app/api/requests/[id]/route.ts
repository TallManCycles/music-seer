import { NextResponse } from "next/server";
import { z } from "zod";
import * as db from "@/lib/db";
import { cancelRequest, reconcile, submitToLidarr } from "@/lib/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  action: z.enum(["resubmit", "refresh"]).optional(),
  ytdlpSource: z.string().optional(),
  autoFallback: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const request = db.getRequest(Number(id));
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ request, events: db.listEvents(request.id) });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const requestId = Number(id);
  const request = db.getRequest(requestId);
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.ytdlpSource !== undefined) {
    db.updateRequest(requestId, { ytdlpSource: parsed.data.ytdlpSource });
  }
  if (parsed.data.autoFallback !== undefined) {
    db.updateRequest(requestId, { autoFallback: parsed.data.autoFallback });
  }

  if (parsed.data.action === "resubmit") {
    db.updateRequest(requestId, { status: "pending", source: "lidarr", lastError: null });
    await submitToLidarr(requestId);
  } else if (parsed.data.action === "refresh") {
    const fresh = db.getRequest(requestId);
    if (fresh) await reconcile(fresh);
  }

  return NextResponse.json({ request: db.getRequest(requestId), events: db.listEvents(requestId) });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const request = db.getRequest(Number(id));
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ request: cancelRequest(request.id) });
}
