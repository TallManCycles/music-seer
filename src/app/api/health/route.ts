import { NextResponse } from "next/server";
import { config, lidarrConfigured } from "@/lib/config";
import { systemStatus } from "@/lib/lidarr";
import { schedulerInfo, tick } from "@/lib/scheduler";
import { commandFor, defaultSourceFor } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("tick") === "1") {
    await tick();
  }
  const cfg = config();
  const lidarr = await systemStatus();
  const sample = commandFor(defaultSourceFor("track", "Daft Punk", "Get Lucky"));
  return NextResponse.json({
    scheduler: schedulerInfo(),
    lidarr: { configured: lidarrConfigured(), ...lidarr },
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
}
