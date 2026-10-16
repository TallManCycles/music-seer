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

# docker CLI (static binary) so we can launch the yt-dlp image via the socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ARG DOCKER_CLI_VERSION=27.2.0
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp --strip-components=1 docker/docker \
 && install -m 0755 /tmp/docker /usr/local/bin/docker \
 && rm -f /tmp/docker.tgz /tmp/docker

# Next.js standalone output already contains the traced production deps plus
# the client assets staged by scripts/stage-standalone.mjs.
COPY --from=builder /app/.next/standalone ./

RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
