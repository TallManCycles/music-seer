import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinReady, lidarrReady } from "@/lib/settings";
import { systemStatus } from "@/lib/lidarr";
import { systemStatus as jellyfinStatus } from "@/lib/jellyfin";
import { schedulerInfo, tick } from "@/lib/scheduler";
import { commandFor, defaultSourceFor } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    if (url.searchParams.get("tick") === "1") {
      await tick();
    }
    const cfg = config();
    const [lidarr, jellyfin] = await Promise.all([systemStatus(), jellyfinStatus()]);
    const sample = commandFor(defaultSourceFor("track", "Daft Punk", "Get Lucky"));
    return NextResponse.json({
      ok: true,
      scheduler: schedulerInfo(),
      lidarr: { configured: lidarrReady(), ...lidarr },
      jellyfin,
      ytdlp: {
        driver: cfg.ytdlp.driver,
        image: cfg.ytdlp.image,
        inbox: cfg.ytdlp.inboxContainerPath,
        spool: cfg.ytdlp.spoolPath,
        archive: cfg.ytdlp.archive,
        sampleCommand: [sample.cmd, ...sample.args].join(" "),
      },
      policy: {
        fallbackAfterMinutes: cfg.fallbackAfterMinutes,
        pollIntervalMinutes: cfg.pollIntervalMinutes,
        completeThreshold: cfg.completeThreshold,
      },
    });
  } catch (err) {
    // A health endpoint that answers with nothing is useless exactly when you
    // need it. Say what broke — usually the database, because the directory it
    // lives in is not writable by the user the app runs as.
    return NextResponse.json(
      {
        ok: false,
        error: "health check failed",
        detail: err instanceof Error ? err.message : String(err),
        scheduler: (() => {
          try {
            return schedulerInfo();
          } catch {
            return undefined;
          }
        })(),
      },
      { status: 503 }
    );
  }
}
