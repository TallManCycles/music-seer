# music-seer

A request manager for **music** — the Jellyseerr idea, translated from films to
artists, albums and tracks.

Search MusicBrainz, hit *Request*, and music-seer tries **Lidarr** first. If
Lidarr cannot deliver (no release, nothing grabbed, a download stuck for too
long), the request is handed to **yt-dlp** automatically — or on demand, with a
URL you supply (a YouTube Music playlist, an album, a single video).

**Jellyfin is the library of record.** Whether something is "available" is
answered by your Jellyfin library, not by Lidarr's bookkeeping: a request that
Jellyfin already has is marked available straight away and never sent to Lidarr
at all, and a yt-dlp download only becomes available once Jellyfin can see it.

```
Discover ──▶ Request ──▶ already in Jellyfin? ──yes──▶ Available
                              │ no
                              ▼
                        Lidarr (artist + album, monitored, searched)
                              │
                              │  not available within the window
                              ▼
                        yt-dlp job (audio in your inbox)
                              │
                              ▼
                   Import pending ──▶ (Jellyfin scan) ──▶ Available
```

It is deliberately single-user and auth-free: put it behind your reverse proxy
or on your LAN, next to the rest of the *arr stack.

---

## What it does

| | |
|---|---|
| **Discover** | Browse your library as a cover-art grid, search MusicBrainz for anything else, and get suggestions drawn from what you already own. |
| **Check** | Asks Jellyfin whether the library already has it. If it does, the request is done — Lidarr is never troubled. |
| **Request** | Otherwise adds the artist and album to Lidarr, monitored, and kicks off a search. Vertical slices: albums and artists are first-class; a *track* request is funnelled through its album and then checked file-by-file. |
| **Suggest** | Takes the artists you own the most of, asks MusicBrainz for their discography, and offers the albums Jellyfin cannot see ("you have 4 albums by AC/DC, here is the fifth"). |
| **Wait** | A reconciler polls Lidarr for "% of tracks on disk" and queue state, so the UI shows real progress. |
| **Fall back** | After `MUSICSEER_FALLBACK_AFTER_MINUTES` (or immediately, if Lidarr has no release at all) the job goes to yt-dlp. |
| **Override** | Any request can be pushed to yt-dlp by hand, with an editable source URL. |
| **Import** | Files land in an *inbox*, not the library. A library scan in Jellyfin (the *Ask Lidarr to import* button also refreshes Jellyfin) is what turns them into `available`. |

## How a download becomes available

The app never moves files into your library. It downloads into an *inbox*, and
something else imports from there:

```
yt-dlp  ──▶  inbox (/mnt/nas/aaron/music-inbox)
                 │  your importer — e.g. beets, which matches tags and files
                 ▼
             library (/mnt/nas/aaron/music-clean)
                 │  Jellyfin scans it
                 ▼
             available  ◀── the app polls Jellyfin and closes the request
```

Because Jellyfin is the library of record, the request moves to `available` by
itself as soon as the importer has filed the album and Jellyfin has scanned it —
no button required. The reconciler polls every
`MUSICSEER_POLL_INTERVAL_MINUTES` (5 by default), so give the importer time
between polls if it runs on a schedule.

Until then the request sits in `import_pending` and says so, and **Rescan
library** asks Jellyfin (and Lidarr, if configured) to look again.

If a download stays in `import_pending` forever, the importer is the thing to
check — the request page shows the files it produced and the event log shows
what the app saw.

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

Then open **Settings** in the app and paste your Jellyfin API key (Jellyfin →
Dashboard → API Keys). You do not have to put it in `.env`: whatever you save in
the app is stored in its database and takes precedence, so you can configure it
from a browser on another machine without touching files on the server.

Two things worth understanding before you start:

1. **The app never runs yt-dlp itself.** With the default `queue` driver it
   writes a job file into `./spool`; the `ytdlp-worker` service in
   `docker-compose.yml` picks it up and runs yt-dlp with the argv the app
   prepared. That is why music-seer needs no Docker socket and runs as a
   non-root user — the only thing crossing the boundary is an argv list.
   `MUSICSEER_INBOX_HOST_PATH` and `MUSICSEER_YTDLP_CONFIG_HOST_PATH` are host
   paths, because compose uses them to mount the worker's `/inbox` and
   `/config` — the same directories your existing yt-dlp service uses.
2. **The inbox is not the library.** Downloads deliberately land in
   `music-inbox` so nothing rewrites your library behind Lidarr's back. Move
   them in with Lidarr's import (the *Ask Lidarr to import* button triggers
   `DownloadedAlbumsScan`) or your own tooling.

## Images

Both images are published to GitHub Container Registry by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) on every push
to `main` and every `v*` tag:

| Image | What it is |
|---|---|
| `ghcr.io/tallmancycles/music-seer` | The web app. |
| `ghcr.io/tallmancycles/music-seer-ytdlp` | The yt-dlp worker — the only thing that runs downloads. |

Multi-arch (`linux/amd64`, `linux/arm64`), tagged `latest`, `<branch>`,
`sha-<short>` and, for version tags, the version. **Pin a tag rather than
`:latest`** if you want a deployment that cannot change under you:

```yaml
image: ghcr.io/tallmancycles/music-seer:sha-abc1234
```

Build them yourself instead with:

```bash
docker build -t music-seer:local .
docker build -f Dockerfile.worker -t music-seer-ytdlp:local .
```

The app image deliberately does **not** include yt-dlp — the default `queue`
driver hands downloads to the worker, which keeps this image small and free of a
per-architecture binary. Add `--build-arg WITH_YTDLP=1` if you want the `local`
driver to work inside it.

## Composing it into an existing arrstack

If you would rather **add the two services to your own compose file** than run a
separate one, use [`docs/arrstack-snippet.yml`](docs/arrstack-snippet.yml) —
paste it into your `services:` block and change nothing else. It joins your
existing network and reaches Lidarr through gluetun the same way the rest of the
stack does.

`docker-compose.arrstack.yml` is the standalone equivalent: it references the
published images and joins an existing docker network — no source tree needed on
the host:

```bash
mkdir -p /path/to/music-seer && cd /path/to/music-seer
curl -O https://raw.githubusercontent.com/TallManCycles/music-seer/main/docker-compose.arrstack.yml
cp .env.example .env && $EDITOR .env      # or copy it from the repo
docker compose -f docker-compose.arrstack.yml up -d
```

**Every folder is a variable** with a working default, so nothing in the compose
file needs editing:

| Variable | Default | What it is |
|---|---|---|
| `MUSICSEER_IMAGE` | `ghcr.io/tallmancycles/music-seer:latest` | App image. |
| `MUSICSEER_WORKER_IMAGE` | `ghcr.io/tallmancycles/music-seer-ytdlp:latest` | Worker image. |
| `MUSICSEER_PORT` | `8666` | Host port (point the reverse proxy here). |
| `MUSICSEER_DATA_DIR` | `./data` | The app's SQLite database. |
| `MUSICSEER_SPOOL_DIR` | `./spool` | Job handoff between app and worker. |
| `MUSICSEER_INBOX_DIR` | `/mnt/nas/aaron/music-inbox` | Where downloads land. |
| `MUSICSEER_CONFIG_DIR` | `/mnt/nas/aaron/ytdlp-config` | yt-dlp config + download archive. |
| `MUSICSEER_INBOX_CONTAINER_PATH` | `/inbox` | Inbox path *inside* the worker. |
| `MUSICSEER_YTDLP_CONFIG_CONTAINER_PATH` | `/config` | Config path *inside* the worker. |
| `MUSICSEER_DOCKER_NETWORK` | `local-docker` | Network to join. |
| `PUID` / `PGID` | `1000` | User the worker runs as. |
| `MUSICSEER_CONTAINER_NAME` / `MUSICSEER_WORKER_CONTAINER_NAME` | `music-seer` / `music-seer-ytdlp` | Container names. |

The two `*_CONTAINER_PATH` values are used for both the mount *and* the app's
configuration, so they cannot drift apart.

Create the host folders first (the inbox and config ones are not created for
you, and a missing bind source silently becomes a root-owned directory):

```bash
mkdir -p /mnt/nas/aaron/music-inbox /mnt/nas/aaron/ytdlp-config
```

The worker is deliberately **not** behind gluetun by default — it is not a
torrent client and it needs to reach the NAS and Lidarr. If you would rather
YouTube saw your VPN address, give it `network_mode: service:gluetun` and drop
its `networks:` entry.

### Two things that will bite you

1. **Ownership of `data` and `spool`.** The app runs as uid 1000 (`node`) and
   the worker runs as `PUID:PGID`, so both directories must be writable by that
   user. Docker creates missing bind-mount directories as `root`, which produces
   a crash loop that looks like a bug in the app:

   ```bash
   mkdir -p data spool && sudo chown -R 1000:1000 data spool
   ```

2. **Lidarr's root folder is its own container path.** In a gluetun setup Lidarr
   has no hostname of its own either — it answers on `http://gluetun:8686`, not
   `http://lidarr:8686`.

### Without Docker

```bash
npm install
npm run build
PORT=8666 npm start   # http://localhost:8666
```

`npm start` runs Next's standalone server and pins the database to
`./data/musicseer.db` and the job spool to `./spool` (Next's standalone
`server.js` changes its working directory at boot, so relative paths would
otherwise land inside `.next/` and be wiped by the next build).
It does **not** read `.env` — pass settings in the environment, or use
`docker compose`, which reads `.env` via `env_file`. The standalone server
listens on `PORT` (3000 unless you set it).

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
| `MUSICSEER_JELLYFIN_URL` | — | Jellyfin base URL. Also settable in the app. |
| `MUSICSEER_JELLYFIN_API_KEY` | — | Jellyfin API key (Dashboard → API Keys). Prefer the Settings page. |
| `MUSICSEER_JELLYFIN_USER_ID` | auto | Only set this if item searches come back empty on your Jellyfin version. |
| `MUSICSEER_FALLBACK_AFTER_MINUTES` | `120` | How long to wait on Lidarr. `0` = never fall back automatically. |
| `MUSICSEER_POLL_INTERVAL_MINUTES` | `5` | Reconciler interval. |
| `MUSICSEER_LIDARR_COMPLETE_THRESHOLD` | `1` | Used only when Jellyfin is not configured: fraction of tracks Lidarr must have on disk to count as "available". `0.95` tolerates a missing bonus track. |
| `MUSICSEER_YTDLP_DRIVER` | `local` | `queue` \| `local` \| `none`. `queue` (the compose default) uses the worker container; `local` runs a `yt-dlp` binary on the app's own PATH. |
| `MUSICSEER_YTDLP_IMAGE` | `jauderho/yt-dlp:latest` | Worker image (compose only). |
| `MUSICSEER_SPOOL_PATH` | `./spool` | Directory the app and the worker share for jobs. |
| `MUSICSEER_INBOX_HOST_PATH` | `/mnt/nas/aaron/music-inbox` | Where downloads land (host path). |
| `MUSICSEER_INBOX_CONTAINER_PATH` | `/inbox` | Where the worker sees the inbox; this is what ends up in yt-dlp's argv. |
| `MUSICSEER_YTDLP_CONFIG_HOST_PATH` | `/home/aaron/docker/ytdlp` | Holds the download archive (host path). |
| `MUSICSEER_YTDLP_ARCHIVE` | `musicseer_archive.txt` | Download-archive filename, so nothing is fetched twice. |
| `MUSICSEER_YTDLP_EXTRA_ARGS` | `[]` | JSON array of extra yt-dlp flags. Only these and the app's own flags are trusted; a user's source is never concatenated into the command line. |

`MUSICSEER_NET_FAMILY_AUTOSELECT` (`auto` | `on` | `off`) is a small escape
hatch: on some dual-stack networks Node's Happy Eyeballs fails fast on
unreachable IPv6 addresses instead of falling back to IPv4, which breaks
outbound HTTP. `auto` disables the autoselection on Windows only.

### Settings in the app

Jellyfin and Lidarr credentials can be set from the **Settings** page instead of
`.env`. That matters when the app runs on a box you only reach through a
browser: paste the API key, hit *Test connection*, and it is used immediately —
no restart, and no shell access required.

Precedence is **saved value → environment**. Clearing a saved value reveals the
`.env` one again. Stored keys live in the SQLite database in plain text and are
never sent back to the browser; the API reports only that a key is set, where it
came from, and its last four characters.

This app has no login of its own. Anyone who can reach it can read your
requests and change these settings, so keep it on your LAN or behind a reverse
proxy that authenticates.

### The yt-dlp command

The worker runs exactly the command you already run, plus a couple of flags so
the app can report back. The app's job file contains this argv, one element per
line:

```bash
yt-dlp \
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
  --print after_move:filepath --newline \
  '<source>'
```

`--print after_move:filepath` is what lets music-seer list the files it
produced; `--no-playlist` is added when the source is a `ytsearch:` query so a
single-track request fetches a single track.

**The source.** The one field a user controls is validated before it is ever
queued: it must be an `http(s)` URL or a `ytsearch[N]:` query (1–50 results),
with no control characters and no leading `-`, and it is passed as the *last*
argv element so it can never be read as an option. Anything else is rejected
with a 400 rather than escaped.

Tracks default to `ytsearch1:<artist> <title>`. Albums default to a search too
— but a search is a guess. For anything you care about, paste the real URL into
the request (the source field appears on every request, and in the *Get via
yt-dlp* flow). A YouTube Music album/playlist URL is exact.

---

## API

All routes are JSON and unauthenticated.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/search?q=&type=artist\|album\|track` | MusicBrainz search, annotated with existing-request state. |
| `GET` | `/api/library?limit=` | Albums in the Jellyfin library, with cover URLs for the browse UI. |
| `GET` | `/api/library/cover?id=&size=` | Cover art proxy — the API key never reaches the browser. |
| `GET` | `/api/discover?limit=` | Suggested albums missing from the library, with the reason for each. |
| `GET` | `/api/requests` | All requests. |
| `POST` | `/api/requests` | Create (or re-request) one. |
| `GET` | `/api/requests/:id` | One request plus its event log. |
| `PATCH` | `/api/requests/:id` | `{action: "refresh" \| "resubmit", ytdlpSource?, autoFallback?}`. |
| `DELETE` | `/api/requests/:id` | Cancel. |
| `POST` | `/api/requests/:id/fallback` | Force yt-dlp, optionally `{source}`. |
| `POST` | `/api/requests/:id/import` | Ask Lidarr to rescan completed downloads. |
| `GET` | `/api/health` | Lidarr/Jellyfin/scheduler/yt-dlp status. Add `?tick=1` to reconcile now. |
| `GET` | `/api/settings` | Credentials in use — masked, plus whether each came from the app or `.env`. |
| `PUT` | `/api/settings` | Save `{jellyfinUrl, jellyfinApiKey, jellyfinUserId, lidarrUrl, lidarrApiKey}`, or `{clear: ["jellyfin"]}`. |
| `POST` | `/api/settings/test` | Try a URL/key without saving it. |
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

CI runs the first three on every push before publishing images, so a broken
build cannot produce a `latest` tag.

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
src/lib/jellyfin.ts      the library of record: is it already in Jellyfin?
src/lib/discover.ts      suggestions: what is missing from artists you own
src/lib/lidarr.ts        Lidarr API: exact-ID lookups, adds, queue, availability
src/lib/db.ts            SQLite (better-sqlite3) storage for requests + events
src/lib/requests.ts      the lifecycle: submit → reconcile → fall back
src/lib/ytdlp.ts         command builder, source validation, output parsing
src/lib/spool.ts         the job handoff between the app and the yt-dlp worker
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
- **Files are never moved for you.** The inbox → library step is Jellyfin's job
  (or yours); music-seer reports what it downloaded and confirms the import once
  Jellyfin can see the file.
- **Jellyfin matching is by name.** Artist/album/track names are normalised
  (case, accents, bracketed qualifiers) and compared exactly, with the artist
  checked too when Jellyfin reports one. A differently-titled pressing will read
  as "not in Jellyfin" rather than being guessed at; the cost of a false
  "available" is that the request is never downloaded.
- **Suggestions need MusicBrainz ids.** They come from the MusicBrainz plugin in
  Jellyfin (`ProviderIds`). Artists without one are skipped rather than guessed
  at, because a wrong match suggests the wrong discography. Suggestions cover
  the four artists you own most of, and are cached for 30 minutes — MusicBrainz
  allows about one request per second.
- **One yt-dlp job at a time.** Serialized on purpose, to be kind to YouTube and
  to your disk.
