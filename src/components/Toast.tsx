"use client";

/**
 * Short-lived confirmation pill. The parent owns the timer; this is purely
 * presentational so it can be dismissed from one place.
 */
export default function Toast({ message, tone = "info" }: { message: string; tone?: "info" | "error" }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4 motion-safe:animate-[toast-in_180ms_ease-out]">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto max-w-md rounded-full border px-4 py-2 text-sm shadow-xl backdrop-blur ${
          tone === "error"
            ? "border-red-400/30 bg-red-500/15 text-red-100"
            : "border-white/10 bg-ink-900/95 text-white/85"
        }`}
      >
        {message}
      </div>
    </div>
  );
}
