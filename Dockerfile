# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# For MUSICSEER_YTDLP_DRIVER=local only. The default (queue) driver runs
# yt-dlp in the separate worker container and needs none of this.
ARG YTDLP_VERSION=2026.10.16
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
      -o /usr/local/bin/yt-dlp \
 && chmod 0755 /usr/local/bin/yt-dlp

# Next.js standalone output already contains the traced production deps plus
# the client assets staged by scripts/stage-standalone.mjs.
COPY --from=builder /app/.next/standalone ./

RUN mkdir -p /app/data /app/spool \
 && chown -R node:node /app/data /app/spool
EXPOSE 3000

# Never run the web app as root: it is exposed on the LAN by design, and this
# is what keeps a future bug in the download path (or anywhere else) contained.
USER node

CMD ["node", "server.js"]
