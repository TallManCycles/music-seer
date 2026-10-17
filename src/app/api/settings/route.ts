import { NextResponse } from "next/server";
import { z } from "zod";
import { publicSettings, saveSettings } from "@/lib/settings";
import { systemStatus as jellyfinStatus } from "@/lib/jellyfin";

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

  // A saved key that Jellyfin rejects is the worst kind of silent failure: the
  // settings page says "saved" and the library page 401s later. Probe it now
  // and say so, rather than letting the user discover it from a broken page.
  let warning: string | undefined;
  if (parsed.data.jellyfinApiKey) {
    const status = await jellyfinStatus();
    if (status.configured && !status.reachable) {
      warning = `Saved, but Jellyfin rejected the credentials: ${status.error ?? "no detail"}. Check the key was copied in full — a Jellyfin API key is 32 characters of hexadecimal (0-9, a-f).`;
    }
  }

  return NextResponse.json({ settings: result.settings, warning });
}
