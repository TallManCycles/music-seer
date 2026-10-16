# music-seer

A request manager for **music** — the Jellyseerr idea, translated from films to
artists, albums and tracks.

Search MusicBrainz, hit *Request*, and music-seer tries **Lidarr** first. If
Lidarr cannot deliver (no release, nothing grabbed, a download stuck for too
long), the request is handed to **yt-dlp** automatically — or on demand, with a
URL you supply (a YouTube Music playlist, an album, a single video).

```
Discover ──▶ Request ──▶ Lidarr (artist + album, monitored, searched)
                             │
                             │  not available within the window
                             ▼
                        yt-dlp job (audio in your inbox)
                             │
                             ▼
                   Import pending ──▶ Available
```

It is deliberately single-user and auth-free: put it behind your reverse proxy
or on your LAN, next to the rest of the *arr stack.

---

## What it does

| | |
|---|---|
| **Discover** | Typeahead search over MusicBrainz for albums, artists and tracks, with Cover Art Archive artwork. |
| **Request** | Adds the artist and album to Lidarr, monitored, and kicks off a search. Vertical slices: albums and artists are first-class; a *track* request is funnelled through its album and then checked file-by-file. |
| **Wait** | A reconciler polls Lidarr for "% of tracks on disk" and queue state, so the UI shows real progress. |
| **Fall back** | After `MUSICSEER_FALLBACK_AFTER_MINUTES` (or immediately, if Lidarr has no release at all) the job goes to yt-dlp. |
| **Override** | Any request can be pushed to yt-dlp by hand, with an editable source URL. |
| **Import** | Files land in an *inbox*, not the library. Optionally ask Lidarr to rescan so it can import them. |

## Why "Lidarr has no release" jumps the queue

The fallback window is for *patience*, not for *impossibility*. If Lidarr
answers "I have no such artist/album", waiting two hours changes nothing, so
music-seer falls back immediately and records the reason in the request log.

Relatedly, artist/album lookups are **strict**: music-seer only binds a request
to Lidarr when it gets an exact `foreignArtistId` / `foreignAlbumId` match (the
`lidarr:<mbid>` lookup). It will not guess from a text search, because binding a
request to the *wrong* release is worse than failing — and failing is safe here,
since yt-dlp catches it.

---

## Quick start (Docker)

```bash
cp .env.example .env
# point at your Lidarr and your inbox
$EDITOR .env

docker compose up -d --build
open http://localhost:8666
```

Two things worth understanding before you start:

1. **Host paths, not container paths.** music-seer launches yt-dlp by running
   `docker run …` against the Docker socket, so `MUSICSEER_INBOX_HOST_PATH` and
   `MUSICSEER_YTDLP_CONFIG_HOST_PATH` must be paths *the Docker daemon* can see
   — the same ones you already use in your yt-dlp compose service.
2. **The inbox is not the library.** Downloads deliberately land in
   `music-inbox` so nothing rewrites your library behind Lidarr's back. Move
   them in with Lidarr's import (the *Ask Lidarr to import* button triggers
   `DownloadedAlbumsScan`) or your own tooling.

### Without Docker

```bash
npm install
npm run build
npm start          # http://localhost:8666
```

`npm start` runs Next's standalone server and pins the database to
`./data/musicseer.db` (Next's standalone `server.js` changes its working
directory at boot, so a relative path would otherwise land inside `.next/`).

---

## Configuration

Everything is environment-driven; see [`.env.example`](.env.example) for the
full list. The ones that change behaviour:

| Variable | Default | Meaning |
|---|---|---|
| `MUSICSEER_LIDARR_URL` | `http://localhost:8686` | Lidarr base URL. |
| `MUSICSEER_LIDARR_API_KEY` | — | Lidarr API key (Settings → General). |
| `MUSICSEER_LIDARR_ROOT_FOLDER` | `/music` | Must exist in Lidarr; falls back to Lidarr's first root folder. |
| `MUSICSEER_LIDARR_QUALITY_PROFILE_ID` / `..._METADATA_PROFILE_ID` | auto | Left blank, music-seer picks Lidarr's defaults. |
| `MUSICSEER_LIDARR_ARTIST_MONITOR` | `all` | `all` \| `future` \| `missing` \| `none`. |
| `MUSICSEER_FALLBACK_AFTER_MINUTES` | `120` | How long to wait on Lidarr. `0` = never fall back automatically. |
| `MUSICSEER_POLL_INTERVAL_MINUTES` | `5` | Reconciler interval. |
| `MUSICSEER_LIDARR_COMPLETE_THRESHOLD` | `1` | Fraction of tracks that counts as "available". `0.95` tolerates a missing bonus track. |
| `MUSICSEER_YTDLP_DRIVER` | `docker` | `docker` \| `local` \| `none`. |
| `MUSICSEER_YTDLP_IMAGE` | `jauderho/yt-dlp:latest` | Image used by the `docker` driver. |
| `MUSICSEER_INBOX_HOST_PATH` | `/mnt/nas/aaron/music-inbox` | Where downloads land (host path). |
| `MUSICSEER_YTDLP_CONFIG_HOST_PATH` | `/home/aaron/docker/ytdlp` | Holds the download archive (host path). |
| `MUSICSEER_YTDLP_ARCHIVE` | `musicseer_archive.txt` | Download-archive filename, so nothing is fetched twice. |
| `MUSICSEER_YTDLP_EXTRA_ARGS` | `[]` | JSON array of extra yt-dlp flags. |

`MUSICSEER_NET_FAMILY_AUTOSELECT` (`auto` | `on` | `off`) is a small escape
hatch: on some dual-stack networks Node's Happy Eyeballs fails fast on
unreachable IPv6 addresses instead of falling back to IPv4, which breaks
outbound HTTP. `auto` disables the autoselection on Windows only.

### The yt-dlp command

music-seer builds the same command you already run, adding a couple of flags so
it can report back:

```bash
docker run --rm \
  -v "$INBOX_HOST:/inbox" \
  -v "$CONFIG_HOST:/config" \
  jauderho/yt-dlp:latest \
  <source> \
  --download-archive /config/musicseer_archive.txt \
  --ignore-errors --sleep-requests 1 --sleep-interval 3 \
  --extract-audio --audio-format m4a \
  --embed-metadata --embed-thumbnail \
  --parse-metadata 'title:(?P<t_artist>.+?) [-–—] (?P<t_title>.+)' \
  --parse-metadata '%(artist,t_artist,uploader)s:%(meta_artist)s' \
  --parse-metadata '%(track,t_title,title)s:%(meta_title)s' \
  --replace-in-metadata meta_artist ' - Topic$' '' \
  --replace-in-metadata meta_title '\s*[\(\[][^\)\]]*(Official|Lyric|Audio|Video|Visuali[sz]er|Clean|Free Download)[^\)\]]*[\)\]]' '' \
  --output '/inbox/%(meta_artist)s - %(meta_title)s [%(id)s].%(ext)s' \
  --print after_move:filepath --newline
```

`--print after_move:filepath` is what lets music-seer list the files it
produced; `--no-playlist` is added when the source is a `ytsearch:` query so a
single-track request fetches a single track.

**The source.** Tracks default to `ytsearch1:<artist> <title>`. Albums default
to a search too — but a search is a guess. For anything you care about, paste
the real URL into the request (the source field appears on every request, and
in the *Get via yt-dlp* flow). A YouTube Music album/playlist URL is exact.

---

## API

All routes are JSON and unauthenticated.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/search?q=&type=artist\|album\|track` | MusicBrainz search, annotated with existing-request state. |
| `GET` | `/api/requests` | All requests. |
| `POST` | `/api/requests` | Create (or re-request) one. |
| `GET` | `/api/requests/:id` | One request plus its event log. |
| `PATCH` | `/api/requests/:id` | `{action: "refresh" \| "resubmit", ytdlpSource?, autoFallback?}`. |
| `DELETE` | `/api/requests/:id` | Cancel. |
| `POST` | `/api/requests/:id/fallback` | Force yt-dlp, optionally `{source}`. |
| `POST` | `/api/requests/:id/import` | Ask Lidarr to rescan completed downloads. |
| `GET` | `/api/health` | Lidarr/scheduler/yt-dlp status. Add `?tick=1` to reconcile now. |
| `GET` | `/api/cover?mbid=&size=` | Cached Cover Art Archive proxy. |

Request statuses: `pending`, `submitted`, `processing`, `fallback_queued`,
`downloading`, `import_pending`, `available`, `failed`, `cancelled`.

---

## Tests

```bash
npm run typecheck     # tsc --noEmit
npm run build
node scripts/e2e.mjs  # 22 checks against a mock Lidarr — no real Lidarr needed
npm run probe         # against a running instance
```

`scripts/e2e.mjs` boots a mock Lidarr and the built server, then drives the
whole lifecycle: add artist/album → reach *available*, refuse duplicates,
detect a missing file, hand a release-less request to yt-dlp immediately honour
an explicit yt-dlp source, cancel, and trigger an import scan. It uses synthetic
MusicBrainz IDs, so only the search check depends on the network.

---

## Layout

```
src/lib/config.ts        env → typed config
src/lib/musicbrainz.ts   rate-limited (1 req/s) MusicBrainz + Cover Art client
src/lib/lidarr.ts        Lidarr API: exact-ID lookups, adds, queue, availability
src/lib/db.ts            SQLite (better-sqlite3) storage for requests + events
src/lib/requests.ts      the lifecycle: submit → reconcile → fall back
src/lib/ytdlp.ts         command builder, serialized job queue, output parsing
src/lib/scheduler.ts     periodic reconciler with restart recovery
src/instrumentation.ts   starts the scheduler with the server
src/app/api/*            HTTP surface
src/components/*         UI
```

## Known limits

- **Single user, no auth.** Deliberate for v1.
- **No playlist import yet.** The plumbing is there (a yt-dlp job takes any
  URL), but there is no dedicated "paste a playlist and bulk-queue it" flow.
  For now, a request with a playlist URL works.
- **Track requests are approximate.** Lidarr only models artists and albums, so
  a track request monitors the whole album and then looks for that one file.
- **Files are never moved for you.** The inbox → library step is Lidarr's job
  (or yours); music-seer only reports what it downloaded.
- **One yt-dlp job at a time.** Serialized on purpose, to be kind to YouTube and
  to your disk.
