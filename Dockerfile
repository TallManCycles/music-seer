# syntax=docker/dockerfile:1
#
# music-seer — the web app.
#
# Multi-arch (amd64/arm64). By default the image does NOT contain yt-dlp: the
# default `queue` driver hands downloads to the separate worker image, which
# keeps this image small and free of a 30MB binary per architecture. Build with
# --build-arg WITH_YTDLP=1 if you want the `local` driver to work inside it.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Force IPv4-first DNS. On a dual-stack host with broken IPv6 egress (Docker
# Desktop on Windows is a common one) the registry resolves to AAAA records
# that never connect, and npm fails instead of falling back. Same class of
# problem src/lib/net-tuning.ts handles for the app itself.
RUN NODE_OPTIONS=--dns-result-order=ipv4first \
    npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=60000

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

ARG WITH_YTDLP=0
ARG YTDLP_VERSION=2026.10.16

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && if [ "$WITH_YTDLP" = "1" ]; then \
      case "${TARGETARCH:-amd64}" in \
        arm64) YTDLP_BIN=yt-dlp_linux_aarch64 ;; \
        *)     YTDLP_BIN=yt-dlp_linux ;; \
      esac; \
      curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_BIN}" \
        -o /usr/local/bin/yt-dlp; \
      chmod 0755 /usr/local/bin/yt-dlp; \
    fi

# Next.js standalone output already contains the traced production deps plus
# the client assets staged by scripts/stage-standalone.mjs.
COPY --from=builder /app/.next/standalone ./

# The database and the job spool are written at runtime. Both live outside the
# image (bind mounts or volumes); the directories exist here so a mounted volume
# inherits the right ownership.
RUN mkdir -p /app/data /app/spool \
 && chown -R node:node /app/data /app/spool

LABEL org.opencontainers.image.title="music-seer" \
      org.opencontainers.image.description="Jellyseerr-style request manager for music, backed by Lidarr with a yt-dlp fallback" \
      org.opencontainers.image.source="https://github.com/TallManCycles/music-seer" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 3000

# Never run the web app as root: it is exposed on the LAN by design.
USER node

# Lets compose wait for the app and lets a reverse proxy see it as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
