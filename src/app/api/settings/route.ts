import { NextResponse } from "next/server";
import { z } from "zod";
import { publicSettings, saveSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Credentials for Jellyfin and Lidarr, editable while the app is running.
 *
 * Like every other route here this is unauthenticated — the whole app assumes
 * it sits on your LAN or behind a reverse proxy. It never returns a stored API
 * key: only whether one is set, where it came from, and its last four
 * characters.
 */
export async function GET() {
  return NextResponse.json({ settings: publicSettings() });
}

const BodySchema = z.object({
  jellyfinUrl: z.string().optional(),
  jellyfinApiKey: z.string().optional(),
  jellyfinUserId: z.string().optional(),
  lidarrUrl: z.string().optional(),
  lidarrApiKey: z.string().optional(),
  clear: z.array(z.enum(["jellyfin", "lidarr"])).optional(),
});

export async function PUT(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const result = saveSettings(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ settings: result.settings });
}
