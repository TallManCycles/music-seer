import { NextResponse } from "next/server";
import { z } from "zod";
import { isUsableUrl, jellyfinCredentials, lidarrCredentials, normalizeUrl } from "@/lib/settings";
import { systemStatus as jellyfinStatus } from "@/lib/jellyfin";
import { systemStatus as lidarrStatus } from "@/lib/lidarr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Try the supplied (or already stored) credentials without saving them, so the
 * Settings page can say "that key works" before you commit to it.
 */
const BodySchema = z.object({
  jellyfinUrl: z.string().optional(),
  jellyfinApiKey: z.string().optional(),
  lidarrUrl: z.string().optional(),
  lidarrApiKey: z.string().optional(),
});

async function probeJellyfin(url: string, apiKey: string) {
  if (!url || !apiKey) return { ok: false, error: "no URL or API key to test" };
  if (!isUsableUrl(url)) return { ok: false, error: "that is not a valid http(s) URL" };
  try {
    const res = await fetch(`${normalizeUrl(url)}/System/Info/Public`, {
      headers: { "X-Emby-Token": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `Jellyfin answered ${res.status} ${res.statusText}` };
    const info = (await res.json()) as { Version?: string; ServerName?: string };
    return { ok: true, detail: `${info.ServerName ?? "Jellyfin"} ${info.Version ?? ""}`.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};
  const stored = jellyfinCredentials();
  const storedLidarr = lidarrCredentials();

  const [jellyfin, lidarr] = await Promise.all([
    probeJellyfin(body.jellyfinUrl?.trim() || stored.url, body.jellyfinApiKey?.trim() || stored.apiKey),
    (async () => {
      const url = body.lidarrUrl?.trim() || storedLidarr.url;
      const apiKey = body.lidarrApiKey?.trim() || storedLidarr.apiKey;
      if (!url || !apiKey) return { ok: false, error: "no URL or API key to test" };
      if (!isUsableUrl(url)) return { ok: false, error: "that is not a valid http(s) URL" };
      // systemStatus() reads whatever is stored, so only trust it when the
      // values under test are the stored ones.
      if (url === storedLidarr.url && apiKey === storedLidarr.apiKey) {
        const status = await lidarrStatus();
        return status.ok
          ? { ok: true, detail: `Lidarr ${status.version ?? ""}`.trim() }
          : { ok: false, error: status.error ?? "unreachable" };
      }
      try {
        const res = await fetch(`${normalizeUrl(url)}/api/v1/system/status`, {
          headers: { "X-Api-Key": apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, error: `Lidarr answered ${res.status} ${res.statusText}` };
        const info = (await res.json()) as { version?: string };
        return { ok: true, detail: `Lidarr ${info.version ?? ""}`.trim() };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })(),
  ]);

  return NextResponse.json({ jellyfin, lidarr });
}
