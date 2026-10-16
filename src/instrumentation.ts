/**
 * Next.js calls this once per server process. It is the hook where the
 * background reconciler (Lidarr polling + yt-dlp queue) comes to life.
 */
export async function register(): Promise<void> {
  // Instrumentation is also compiled for the Edge runtime; all of the work
  // below is Node-only, so bail out early and import lazily.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { tuneNetworking } = await import("./lib/net-tuning");
  tuneNetworking();

  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.MUSICSEER_DISABLE_SCHEDULER === "1") return;

  try {
    const { start } = await import("./lib/scheduler");
    start();
  } catch (err) {
    console.error("[music-seer] failed to start scheduler:", err);
  }
}
