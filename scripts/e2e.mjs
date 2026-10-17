#!/usr/bin/env node
/**
 * End-to-end check of the request pipeline without a real Lidarr.
 *
 * It boots:
 *   1. a mock Lidarr API on :8687
 *   2. the built music-seer server on :8667, pointed at the mock
 *
 * ...then drives the whole lifecycle: add artist/album, reach "available",
 * refuse duplicates, fall back to yt-dlp (driver=none, so nothing downloads),
 * and honour explicit yt-dlp sources.
 *
 *   npm run build && node scripts/e2e.mjs
 *
 * Requests use synthetic MusicBrainz IDs so the deterministic parts never
 * depend on the MusicBrainz service being up (its reachability is a soft check).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const LIDARR_PORT = 8687;
const APP_PORT = 8667;
const BASE = `http://127.0.0.1:${APP_PORT}`;
// Absolute: Next's standalone server.js chdir()s into .next/standalone, so a
// relative path would resolve somewhere else entirely.
const DB = path.join(process.cwd(), "data", "e2e.db");

const ARTIST_MBID = "11111111-1111-1111-1111-111111111111";
const RGID = "22222222-2222-2222-2222-222222222222";
const RGID2 = "33333333-3333-3333-3333-333333333333";
const RGID3 = "44444444-4444-4444-4444-444444444444";
const UNKNOWN_MBID = "00000000-0000-0000-0000-000000000999";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- mock Lidarr -----------------------------------------------------------

const mock = {
  artists: [],
  albums: [],
  tracks: [],
  percents: {},
  nextArtistId: 101,
  nextAlbumId: 201,
};

const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const mockServer = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${LIDARR_PORT}`);
  const p = url.pathname;
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};

    if (p === "/__control") {
      if (body.tracks) mock.tracks = body.tracks;
      if (body.percents) Object.assign(mock.percents, body.percents);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/v1/system/status") return send(res, 200, { version: "2.6.0.4400" });
    if (p === "/api/v1/qualityprofile") return send(res, 200, [{ id: 1, name: "Standard" }]);
    if (p === "/api/v1/metadataprofile") return send(res, 200, [{ id: 1, name: "Standard" }]);
    if (p === "/api/v1/rootfolder") return send(res, 200, [{ id: 1, path: "/music" }]);
    if (p === "/api/v1/command") return send(res, 201, { id: 1, name: body.name });

    // Mirror real Lidarr: a `lidarr:`/`mbid:`/`release-group:` term is an exact
    // ID lookup. A plain text term returns real release groups (never our id).
    const idFrom = (term) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term) ? term : null;

    if (p === "/api/v1/artist/lookup") {
      const raw = url.searchParams.get("term") ?? "";
      const mbid = idFrom(raw.replace(/^(lidarr:|mbid:)/, ""));
      if (!mbid || mbid.startsWith("00000000")) return send(res, 200, []);
      return send(res, 200, [{ id: 0, artistName: "Mock Artist", foreignArtistId: mbid }]);
    }
    if (p === "/api/v1/artist" && req.method === "GET") return send(res, 200, mock.artists);
    if (p === "/api/v1/artist" && req.method === "POST") {
      const existing = mock.artists.find((a) => a.foreignArtistId === body.foreignArtistId);
      if (existing) return send(res, 400, { message: "already added" });
      const artist = { ...body, id: mock.nextArtistId++ };
      mock.artists.push(artist);
      return send(res, 201, artist);
    }
    if (/^\/api\/v1\/artist\/\d+$/.test(p) && req.method === "GET") {
      const id = Number(p.split("/").pop());
      const artist = mock.artists.find((a) => a.id === id);
      if (!artist) return send(res, 404, { message: "no such artist" });
      return send(res, 200, { ...artist, statistics: { percentOfTracks: 100, trackFileCount: 10, totalTrackCount: 10 } });
    }

    if (p === "/api/v1/album/lookup") {
      const raw = url.searchParams.get("term") ?? "";
      const mbid = idFrom(raw.replace(/^(lidarr:|mbid:|release-group:)/, ""));
      if (!mbid || mbid.startsWith("00000000")) return send(res, 200, []);
      return send(res, 200, [{ id: 0, title: "Mock Album", foreignAlbumId: mbid }]);
    }
    if (p === "/api/v1/album" && req.method === "GET") {
      const artistId = Number(url.searchParams.get("artistId"));
      return send(res, 200, mock.albums.filter((a) => a.artistId === artistId));
    }
    if (p === "/api/v1/album" && req.method === "POST") {
      const album = { ...body, id: mock.nextAlbumId++ };
      mock.albums.push(album);
      return send(res, 201, album);
    }
    if (/^\/api\/v1\/album\/\d+$/.test(p) && req.method === "GET") {
      const id = Number(p.split("/").pop());
      const album = mock.albums.find((a) => a.id === id);
      if (!album) return send(res, 404, { message: "no such album" });
      const pct = mock.percents[album.foreignAlbumId] ?? 100;
      const total = 10;
      const files = Math.round((pct / 100) * total);
      return send(res, 200, {
        ...album,
        statistics: { percentOfTracks: pct, trackFileCount: files, totalTrackCount: total },
      });
    }
    if (p === "/api/v1/track") {
      const albumId = Number(url.searchParams.get("albumId"));
      return send(res, 200, mock.tracks.map((t, i) => ({ id: i + 1, title: t, albumId, hasFile: true })));
    }
    if (p === "/api/v1/queue/details") return send(res, 200, { records: [] });

    return send(res, 404, { message: `unhandled ${req.method} ${p}` });
  });
});

// --- helpers ---------------------------------------------------------------

const api = async (path, init) => {
  const res = await fetch(BASE + path, init);
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* empty */
  }
  return { code: res.status, body };
};
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const patch = (path, body) =>
  api(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
const refresh = (id) => patch(`/api/requests/${id}`, { action: "refresh" });

/** Talk to the mock Lidarr directly (the app is on a different port). */
const mockPost = (path, body) =>
  fetch(`http://127.0.0.1:${LIDARR_PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const waitFor = async (label, fn, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${label}`);
};

// --- run -------------------------------------------------------------------

let child;
let failures = 0;

try {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f, { force: true });
  await new Promise((r) => mockServer.listen(LIDARR_PORT, "127.0.0.1", r));
  console.log(`mock Lidarr listening on :${LIDARR_PORT}`);

  if (!existsSync(".next/standalone/server.js")) {
    throw new Error("run `npm run build` first");
  }

  child = spawn(process.execPath, [".next/standalone/server.js"], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      MUSICSEER_DB_PATH: DB,
      MUSICSEER_LIDARR_URL: `http://127.0.0.1:${LIDARR_PORT}`,
      MUSICSEER_LIDARR_API_KEY: "test-key",
      MUSICSEER_LIDARR_ROOT_FOLDER: "/music",
      MUSICSEER_YTDLP_DRIVER: "none",
      MUSICSEER_FALLBACK_AFTER_MINUTES: "60",
      MUSICSEER_POLL_INTERVAL_MINUTES: "60",
      MUSICSEER_USER_AGENT: "music-seer-e2e/0.1 (test)",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitFor("music-seer to boot", async () => (await api("/api/health")).code === 200);
  console.log(`music-seer listening on :${APP_PORT}\n`);

  // 1. health / connectivity
  const health = (await api("/api/health")).body;
  check("health reports Lidarr reachable", health.lidarr?.ok === true, health.lidarr?.version);
  check("scheduler is running", health.scheduler?.running === true);

  // 2. MusicBrainz reachability (soft)
  const mb = await api("/api/search?q=Daft%20Punk&type=artist");
  check("MusicBrainz search reachable (soft)", mb.code === 200 && (mb.body.results?.length ?? 0) > 0,
    mb.code === 200 ? `${mb.body.results?.length ?? 0} artists` : `HTTP ${mb.code}: ${mb.body.error}`);

  // 3. album request -> Lidarr -> available
  const album = await post("/api/requests", {
    type: "album", mbid: RGID, releaseGroupMbid: RGID,
    title: "Mock Album", artist: "Mock Artist", artistMbid: ARTIST_MBID, year: "2001",
  });
  check("album request created", album.code === 201, `status=${album.body.request?.status}`);
  check("album handed to Lidarr", album.body.request?.status === "submitted",
    album.body.request?.statusDetail);
  check("artist was added to Lidarr", album.body.request?.lidarrArtistId === 101);
  check("album was added to Lidarr", album.body.request?.lidarrAlbumId === 201);

  const albumId = album.body.request.id;
  let r = (await refresh(albumId)).body.request;
  check("album reconciled to available", r.status === "available", r.statusDetail);

  const dup = await post("/api/requests", {
    type: "album", mbid: RGID, releaseGroupMbid: RGID, title: "Mock Album", artist: "Mock Artist",
  });
  check("duplicate request is refused", dup.body.duplicate === true && dup.body.request?.id === albumId,
    `code=${dup.code} id=${dup.body.request?.id}`);

  // 4. artist request
  const artist = await post("/api/requests", {
    type: "artist", mbid: ARTIST_MBID, title: "Mock Artist", artist: "Mock Artist", artistMbid: ARTIST_MBID,
  });
  const artistId = artist.body.request.id;
  r = (await refresh(artistId)).body.request;
  check("artist reconciled to available", r.status === "available", r.statusDetail);

  // 5. track request -> album -> exact track-file match
  const trackReq = await post("/api/requests", {
    type: "track", mbid: "55555555-5555-5555-5555-555555555555", releaseGroupMbid: RGID2,
    title: "Mock Song", artist: "Mock Artist", artistMbid: ARTIST_MBID, albumTitle: "Mock Album 2",
  });
  const trackId = trackReq.body.request.id;
  await mockPost("/__control", { tracks: [], percents: { [RGID2]: 0 } }); // album not in the library yet
  r = (await refresh(trackId)).body.request;
  check("track not available while file is missing", r.status !== "available", r.statusDetail);

  await mockPost("/__control", { tracks: ["Mock Song"] }); // the track file now exists
  r = (await refresh(trackId)).body.request;
  check("track matched by title and marked available",
    r.status === "available" && /track file present/.test(r.statusDetail ?? ""), r.statusDetail);

  // 6. Lidarr has no release -> immediate yt-dlp handoff
  const missing = await post("/api/requests", {
    type: "album", mbid: UNKNOWN_MBID, releaseGroupMbid: UNKNOWN_MBID,
    title: "Nonexistent", artist: "Nobody", artistMbid: UNKNOWN_MBID,
  });
  const missingId = missing.body.request.id;
  r = (await refresh(missingId)).body.request;
  check("missing release falls back without waiting", r.source === "ytdlp" && r.status !== "submitted",
    `${r.status} — ${r.statusDetail}`);
  const missingLog = await api(`/api/requests/${missingId}`);
  check("fallback log records why", /could not find/i.test(JSON.stringify(missingLog.body.events ?? [])),
    (missingLog.body.events ?? []).map((e) => e.message).find((m) => /could not find/i.test(m))?.slice(0, 90));

  // 7. manual yt-dlp override with an explicit source
  const slow = await post("/api/requests", {
    type: "album", mbid: RGID3, releaseGroupMbid: RGID3,
    title: "Slow Album", artist: "Mock Artist", artistMbid: ARTIST_MBID,
  });
  const slowId = slow.body.request.id;
  await mockPost("/__control", { percents: { [RGID3]: 0 } });
  r = (await refresh(slowId)).body.request;
  check("incomplete album stays with Lidarr", r.status !== "available" && r.source === "lidarr",
    `${r.status} — ${r.statusDetail}`);

  const forced = await post(`/api/requests/${slowId}/fallback`, {
    source: "https://music.youtube.com/playlist?list=PLtest",
  });
  check("manual yt-dlp override accepted",
    forced.body.request?.ytdlpSource === "https://music.youtube.com/playlist?list=PLtest",
    `status=${forced.body.request?.status}`);
  check("explicit source is rejected when downloads are disabled",
    forced.body.request?.status === "failed" && /disabled/.test(forced.body.request?.lastError ?? ""),
    forced.body.request?.lastError);

  const imp = await post(`/api/requests/${slowId}/import`, {});
  check("a library rescan can be triggered", imp.code === 200 && /rescan/i.test(imp.body.request?.statusDetail ?? ""),
    imp.body.request?.statusDetail);

  // 8. cancellation
  const cancel = await post("/api/requests", {
    type: "album", mbid: "66666666-6666-6666-6666-666666666666", releaseGroupMbid: "66666666-6666-6666-6666-666666666666",
    title: "Cancel Me", artist: "Mock Artist", artistMbid: ARTIST_MBID,
  });
  const del = await api(`/api/requests/${cancel.body.request.id}`, { method: "DELETE" });
  check("cancel sets status cancelled", del.body.request?.status === "cancelled");

  // 9. validation + log
  const bad = await post("/api/requests", { type: "bogus" });
  check("invalid payload rejected", bad.code === 400);
  const detail = await api(`/api/requests/${albumId}`);
  check("event log recorded the lifecycle", (detail.body.events?.length ?? 0) >= 3,
    `${detail.body.events?.length ?? 0} events`);

  const list = await api("/api/requests");
  check("request list is complete", (list.body.requests?.length ?? 0) === 6,
    `${list.body.requests?.length} requests`);

  failures = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
} catch (err) {
  console.error("\ne2e aborted:", err instanceof Error ? err.message : err);
  failures = 1;
} finally {
  child?.kill();
  mockServer.close();
}

process.exit(failures === 0 ? 0 : 1);
