import { NextResponse } from "next/server";
import { requestImportScan } from "@/lib/requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Ask Lidarr to rescan its completed-download folders (inbox -> library). */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const request = await requestImportScan(Number(id));
  if (!request) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ request });
}
