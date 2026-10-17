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
fail() { echo "[ytdlp-worker] ERROR: $*" >&2; exit 1; }

# The spool and the inbox are normally bind mounts owned by the host user. If
# they are not writable this worker cannot do its job at all — and skipping
# every job in silence is the worst possible outcome, because the queue just
# grows while nothing downloads. Stop instead, so the container is visibly
# restarting rather than quietly useless.
[ -d "$SPOOL_DIR" ] || mkdir -p "$SPOOL_DIR" 2>/dev/null || fail "cannot create $SPOOL_DIR"
[ -d "$INBOX_DIR" ] || mkdir -p "$INBOX_DIR" 2>/dev/null || fail "cannot create $INBOX_DIR"
[ -w "$SPOOL_DIR" ] || fail "$SPOOL_DIR is not writable by uid $(id -u). The bind mount must be owned by PUID/PGID."
[ -w "$INBOX_DIR" ] || fail "$INBOX_DIR is not writable by uid $(id -u). The bind mount must be owned by PUID/PGID."

log "watching $SPOOL_DIR (poll ${POLL_SECONDS}s), writing to $INBOX_DIR"
command -v "$YTDLP_BIN" >/dev/null 2>&1 || log "WARNING: $YTDLP_BIN not found on PATH"

claim_warned=0

while :; do
  found=0

  for job in "$SPOOL_DIR"/*.job; do
    [ -e "$job" ] || continue
    found=1

    base="${job%.job}"
    running="$base.running"

    # Claim the job. If another worker got here first, skip it — but if we
    # simply cannot write, say so rather than looking idle.
    if ! mv "$job" "$running" 2>/dev/null; then
      if [ "$claim_warned" = 0 ]; then
        log "cannot claim $(basename "$job") — check ownership of $SPOOL_DIR"
        claim_warned=1
      fi
      continue
    fi
    claim_warned=0

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
