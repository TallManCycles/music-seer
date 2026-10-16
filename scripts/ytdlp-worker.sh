#!/bin/sh
#
# music-seer yt-dlp worker.
#
# The web app never executes anything: it drops a job into a shared spool
# directory and this container picks it up. That removes the need for the app
# to hold the Docker socket (and therefore to be able to start containers as
# root) while still keeping the download tool out of the web app's image.
#
# Contract (see src/lib/spool.ts for the app side):
#
#   <id>.args     argv for yt-dlp, one element per line, trailing newline
#   <id>.job      empty marker; presence means "there is work"
#   <id>.running  created by renaming <id>.job; atomic, so exactly one worker
#                 runs a given job
#   <id>.log      yt-dlp's combined output, appended live
#   <id>.status   written last (temp + rename): "ok" or "fail:<exit code>"
#
# The args file is newline-delimited, so the app refuses to queue any source
# containing a control character. Do not loosen that check.

set -u

SPOOL_DIR="${SPOOL_DIR:-/spool}"
INBOX_DIR="${INBOX_DIR:-/inbox}"
POLL_SECONDS="${POLL_SECONDS:-5}"
YTDLP_BIN="${YTDLP_BIN:-yt-dlp}"

log() { echo "[ytdlp-worker] $*"; }

mkdir -p "$SPOOL_DIR" "$INBOX_DIR"
log "watching $SPOOL_DIR (poll ${POLL_SECONDS}s), writing to $INBOX_DIR"
command -v "$YTDLP_BIN" >/dev/null 2>&1 || log "WARNING: $YTDLP_BIN not found on PATH"

while :; do
  found=0

  for job in "$SPOOL_DIR"/*.job; do
    [ -e "$job" ] || continue
    found=1

    base="${job%.job}"
    running="$base.running"

    # Claim the job. If another worker got here first, skip it.
    if ! mv "$job" "$running" 2>/dev/null; then
      continue
    fi

    : > "$base.log"

    # Rebuild argv from the newline-delimited args file, preserving empty
    # elements (yt-dlp is given two intentionally empty arguments).
    set --
    while IFS= read -r line; do
      set -- "$@" "$line"
    done < "$base.args"

    if [ "$#" -eq 0 ]; then
      log "job $(basename "$base") has no arguments; failing it"
      echo "ERROR: no arguments in $(basename "$base").args" >> "$base.log"
      echo "fail:no-args" > "$base.status.tmp"
      mv "$base.status.tmp" "$base.status"
      rm -f "$running"
      continue
    fi

    log "running job $(basename "$base")"
    if "$YTDLP_BIN" "$@" >> "$base.log" 2>&1; then
      status="ok"
    else
      status="fail:$?"
    fi

    echo "$status" > "$base.status.tmp"
    mv "$base.status.tmp" "$base.status"
    rm -f "$running"
    log "job $(basename "$base") finished: $status"
  done

  [ "$found" -eq 1 ] || sleep "$POLL_SECONDS"
done
