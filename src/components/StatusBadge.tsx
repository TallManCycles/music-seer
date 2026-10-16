import type { RequestStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_TONE, TONE_CLASS } from "@/lib/status";

export default function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONE_CLASS[STATUS_TONE[status]]}`}
    >
      {(status === "downloading" || status === "processing") && (
        <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}
