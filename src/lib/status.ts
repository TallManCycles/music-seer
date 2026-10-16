import type { RequestStatus } from "./types";

export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Pending",
  submitted: "Sent to Lidarr",
  processing: "Downloading (Lidarr)",
  fallback_queued: "Queued for yt-dlp",
  downloading: "Downloading (yt-dlp)",
  import_pending: "In inbox — awaiting import",
  available: "Available",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type Tone = "neutral" | "info" | "ok" | "warn" | "bad";

export const STATUS_TONE: Record<RequestStatus, Tone> = {
  pending: "neutral",
  submitted: "info",
  processing: "info",
  fallback_queued: "warn",
  downloading: "warn",
  import_pending: "warn",
  available: "ok",
  failed: "bad",
  cancelled: "neutral",
};

export const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-ink-700 text-white/70 ring-white/10",
  info: "bg-indigo-500/15 text-indigo-300 ring-indigo-400/30",
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
  bad: "bg-red-500/15 text-red-300 ring-red-400/30",
};

export const ACTIVE_STATUSES: RequestStatus[] = [
  "pending",
  "submitted",
  "processing",
  "fallback_queued",
  "downloading",
  "import_pending",
];

export function isActive(status: RequestStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function formatRelative(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
