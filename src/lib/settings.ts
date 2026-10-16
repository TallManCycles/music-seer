import { config } from "./config";
import * as db from "./db";

/**
 * Credentials can be set two ways: in the environment (deployment config) or
 * from the Settings page (stored in SQLite). Stored values win, so you can
 * paste an API key into the running app instead of editing `.env` and
 * restarting — which is the only practical option when the app runs on a box
 * you reach through a browser.
 *
 * Reads hit SQLite on every call (a prepared lookup against one row) rather
 * than caching, so a key pasted into the UI takes effect immediately.
 */

const KEYS = {
  jellyfinUrl: "jellyfin.url",
  jellyfinApiKey: "jellyfin.apiKey",
  jellyfinUserId: "jellyfin.userId",
  lidarrUrl: "lidarr.url",
  lidarrApiKey: "lidarr.apiKey",
} as const;

export interface Credentials {
  url: string;
  apiKey: string;
}

/** A URL is only usable if it is http(s); anything else is a paste error. */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function isUsableUrl(raw: string): boolean {
  try {
    const url = new URL(normalizeUrl(raw));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function stored(key: string): string | null {
  const value = db.getSetting(key);
  return value && value.trim() ? value.trim() : null;
}

function effective(key: string, envValue: string): string {
  return stored(key) ?? envValue.trim();
}

// --- effective credentials -------------------------------------------------

export function jellyfinCredentials(): {
  url: string;
  apiKey: string;
  userId?: string;
} {
  const env = config().jellyfin;
  return {
    url: effective(KEYS.jellyfinUrl, env.url),
    apiKey: effective(KEYS.jellyfinApiKey, env.apiKey),
    userId: stored(KEYS.jellyfinUserId) ?? env.userId ?? undefined,
  };
}

export function jellyfinReady(): boolean {
  const { url, apiKey } = jellyfinCredentials();
  return isUsableUrl(url) && Boolean(apiKey);
}

export function lidarrCredentials(): Credentials {
  const env = config().lidarr;
  return {
    url: effective(KEYS.lidarrUrl, env.url),
    apiKey: effective(KEYS.lidarrApiKey, env.apiKey),
  };
}

export function lidarrReady(): boolean {
  const { url, apiKey } = lidarrCredentials();
  return isUsableUrl(url) && Boolean(apiKey);
}

// --- the Settings page -----------------------------------------------------

/** Where a value came from, so the UI can explain what it is showing. */
export type SettingSource = "stored" | "environment" | "unset";

export interface PublicCredentials {
  url: string;
  urlSource: SettingSource;
  apiKeySet: boolean;
  apiKeySource: SettingSource;
  /** Last four characters of the key in use, so you can tell two apart. */
  apiKeyHint?: string;
  userId?: string;
}

export interface PublicSettings {
  jellyfin: PublicCredentials;
  lidarr: PublicCredentials;
}

function hint(apiKey: string): string | undefined {
  if (!apiKey) return undefined;
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}

function publicCreds(
  urlKey: string,
  apiKeyKey: string,
  envUrl: string,
  envApiKey: string,
  userId: string | null
): PublicCredentials {
  const { url, apiKey } = { url: effective(urlKey, envUrl), apiKey: effective(apiKeyKey, envApiKey) };
  return {
    url,
    urlSource: stored(urlKey) ? "stored" : envUrl.trim() ? "environment" : "unset",
    apiKeySet: Boolean(apiKey),
    apiKeySource: stored(apiKeyKey) ? "stored" : envApiKey.trim() ? "environment" : "unset",
    apiKeyHint: hint(apiKey),
    userId: userId ?? undefined,
  };
}

export function publicSettings(): PublicSettings {
  const env = config();
  return {
    jellyfin: publicCreds(
      KEYS.jellyfinUrl,
      KEYS.jellyfinApiKey,
      env.jellyfin.url,
      env.jellyfin.apiKey,
      stored(KEYS.jellyfinUserId) ?? env.jellyfin.userId ?? null
    ),
    lidarr: publicCreds(
      KEYS.lidarrUrl,
      KEYS.lidarrApiKey,
      env.lidarr.url,
      env.lidarr.apiKey,
      null
    ),
  };
}

// --- writes ----------------------------------------------------------------

export interface SettingsPatch {
  jellyfinUrl?: string;
  jellyfinApiKey?: string;
  jellyfinUserId?: string;
  lidarrUrl?: string;
  lidarrApiKey?: string;
  /** Drop stored values and fall back to the environment. */
  clear?: Array<"jellyfin" | "lidarr">;
}

export type SaveResult = { ok: true; settings: PublicSettings } | { ok: false; error: string };

/**
 * Save what was provided. Empty strings clear a stored value (so you fall back
 * to the environment) — but the API key is only touched when it is actually
 * present in the request, so saving the URL does not wipe a saved key.
 */
export function saveSettings(patch: SettingsPatch): SaveResult {
  const writes: Array<[string, string | null]> = [];

  const urlField = (key: string, value: string | undefined, label: string) => {
    if (value === undefined) return;
    const trimmed = normalizeUrl(value);
    if (!trimmed) {
      writes.push([key, null]); // clear it
      return;
    }
    if (!isUsableUrl(trimmed)) {
      throw new Error(`${label} must be a full http(s) URL, e.g. http://192.168.0.201:8096`);
    }
    writes.push([key, trimmed]);
  };

  try {
    urlField(KEYS.jellyfinUrl, patch.jellyfinUrl, "Jellyfin URL");
    urlField(KEYS.lidarrUrl, patch.lidarrUrl, "Lidarr URL");

    if (patch.jellyfinApiKey !== undefined) {
      const key = patch.jellyfinApiKey.trim();
      writes.push([KEYS.jellyfinApiKey, key ? key : null]);
    }
    if (patch.lidarrApiKey !== undefined) {
      const key = patch.lidarrApiKey.trim();
      writes.push([KEYS.lidarrApiKey, key ? key : null]);
    }
    if (patch.jellyfinUserId !== undefined) {
      const id = patch.jellyfinUserId.trim();
      writes.push([KEYS.jellyfinUserId, id ? id : null]);
    }

    for (const target of patch.clear ?? []) {
      if (target === "jellyfin") {
        writes.push([KEYS.jellyfinUrl, null], [KEYS.jellyfinApiKey, null], [KEYS.jellyfinUserId, null]);
      } else {
        writes.push([KEYS.lidarrUrl, null], [KEYS.lidarrApiKey, null]);
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  for (const [key, value] of writes) {
    if (value === null) db.deleteSetting(key);
    else db.setSetting(key, value);
  }

  return { ok: true, settings: publicSettings() };
}
