import { imageResponse } from "@/lib/jellyfin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cover art proxy for library albums: the browser never sees the API key.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const size = Number(url.searchParams.get("size") ?? 300);

  // Jellyfin item ids are GUIDs, with or without dashes; anything else is not ours.
  if (!id || !/^[0-9a-f-]{32,36}$/i.test(id)) {
    return new Response("bad id", { status: 400 });
  }

  try {
    return await imageResponse(id, Number.isFinite(size) ? Math.min(size, 1200) : 300);
  } catch {
    return new Response("no image", { status: 404 });
  }
}
