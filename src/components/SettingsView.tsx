"use client";

import { useCallback, useEffect, useState } from "react";

type SettingSource = "stored" | "environment" | "unset";

interface Credentials {
  url: string;
  urlSource: SettingSource;
  apiKeySet: boolean;
  apiKeySource: SettingSource;
  apiKeyHint?: string;
  userId?: string;
}

interface Settings {
  jellyfin: Credentials;
  lidarr: Credentials;
}

type Probe = { ok: boolean; detail?: string; error?: string };

const sourceLabel: Record<SettingSource, string> = {
  stored: "saved here",
  environment: "from .env",
  unset: "not set",
};

function Source({ source, hint }: { source: SettingSource; hint?: string }) {
  const tone =
    source === "stored" ? "text-accent-soft" : source === "environment" ? "text-white/45" : "text-bad";
  return (
    <span className={`text-xs ${tone}`}>
      {sourceLabel[source]}
      {hint ? ` · ${hint}` : ""}
    </span>
  );
}

function Result({ probe }: { probe?: Probe }) {
  if (!probe) return null;
  const tone = probe.ok ? "text-ok" : "text-bad";
  return <p className={`mt-2 text-xs ${tone}`}>{probe.ok ? `✓ ${probe.detail}` : `✕ ${probe.error}`}</p>;
}

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<{ jellyfin?: Probe; lidarr?: Probe }>({});

  const [jellyfinUrl, setJellyfinUrl] = useState("");
  const [jellyfinKey, setJellyfinKey] = useState("");
  const [jellyfinUserId, setJellyfinUserId] = useState("");
  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrKey, setLidarrKey] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSettings(body.settings);
      setJellyfinUrl(body.settings.jellyfin.url ?? "");
      setJellyfinUserId(body.settings.jellyfin.userId ?? "");
      setLidarrUrl(body.settings.lidarr.url ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      // Only send the API keys when one was typed, so saving the URLs cannot
      // wipe a key that is already stored.
      const payload: Record<string, unknown> = { jellyfinUrl, jellyfinUserId, lidarrUrl };
      if (jellyfinKey.trim()) payload.jellyfinApiKey = jellyfinKey.trim();
      if (lidarrKey.trim()) payload.lidarrApiKey = lidarrKey.trim();

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSettings(body.settings);
      setJellyfinKey("");
      setLidarrKey("");
      setSaved("Saved. New requests use these credentials immediately.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setProbes({});
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jellyfinUrl,
          jellyfinApiKey: jellyfinKey.trim() || undefined,
          lidarrUrl,
          lidarrApiKey: lidarrKey.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setProbes(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (target: "jellyfin" | "lidarr") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: [target] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSettings(body.settings);
      setSaved(`Cleared the saved ${target} settings; falling back to .env.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-white/50">
          Paste credentials here while the app is running — no restart, no editing files on the
          server. Saved values take precedence over <code className="text-white/70">.env</code>.
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>
      )}
      {saved && (
        <p className="rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">{saved}</p>
      )}

      <section className="space-y-4 rounded-xl border border-white/5 bg-ink-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/45">
            Jellyfin <span className="text-white/30">· library of record</span>
          </h2>
          {settings && settings.jellyfin.apiKeySet && (
            <span className="text-xs text-white/40">
              using key <span className="text-white/70">{settings.jellyfin.apiKeyHint}</span>
            </span>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm text-white/70">Server URL</span>
          <input
            value={jellyfinUrl}
            onChange={(e) => setJellyfinUrl(e.target.value)}
            placeholder="http://192.168.0.201:8096"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-accent/50"
          />
          {settings && <Source source={settings.jellyfin.urlSource} />}
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm text-white/70">API key</span>
          <input
            type="password"
            value={jellyfinKey}
            onChange={(e) => setJellyfinKey(e.target.value)}
            autoComplete="off"
            placeholder={settings?.jellyfin.apiKeySet ? "leave blank to keep the saved key" : "paste the key"}
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-accent/50"
          />
          <span className="flex items-center gap-2">
            {settings && <Source source={settings.jellyfin.apiKeySource} hint={settings.jellyfin.apiKeyHint} />}
          </span>
          <span className="block text-xs text-white/35">
            Jellyfin → Dashboard → API Keys → <em>+</em>. Shown only once, so paste it here now.
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm text-white/70">
            User ID <span className="text-white/35">(optional)</span>
          </span>
          <input
            value={jellyfinUserId}
            onChange={(e) => setJellyfinUserId(e.target.value)}
            placeholder="only if album searches come back empty"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-accent/50"
          />
        </label>

        <Result probe={probes.jellyfin} />
      </section>

      <section className="space-y-4 rounded-xl border border-white/5 bg-ink-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/45">
            Lidarr <span className="text-white/30">· downloads</span>
          </h2>
          {settings && settings.lidarr.apiKeySet && (
            <span className="text-xs text-white/40">
              using key <span className="text-white/70">{settings.lidarr.apiKeyHint}</span>
            </span>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm text-white/70">URL</span>
          <input
            value={lidarrUrl}
            onChange={(e) => setLidarrUrl(e.target.value)}
            placeholder="http://192.168.0.201:8686"
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-accent/50"
          />
          {settings && <Source source={settings.lidarr.urlSource} />}
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm text-white/70">API key</span>
          <input
            type="password"
            value={lidarrKey}
            onChange={(e) => setLidarrKey(e.target.value)}
            autoComplete="off"
            placeholder={settings?.lidarr.apiKeySet ? "leave blank to keep the saved key" : "paste the key"}
            className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-accent/50"
          />
          <span className="flex items-center gap-2">
            {settings && <Source source={settings.lidarr.apiKeySource} hint={settings.lidarr.apiKeyHint} />}
          </span>
          <span className="block text-xs text-white/35">Lidarr → Settings → General → API Key.</span>
        </label>

        <Result probe={probes.lidarr} />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-lg bg-accent/20 px-4 py-2 text-sm font-medium text-accent-soft ring-1 ring-accent/40 transition hover:bg-accent/30 disabled:opacity-50"
        >
          Save
        </button>
        <button
          onClick={() => void test()}
          disabled={busy}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 transition hover:bg-white/5 disabled:opacity-50"
        >
          Test connection
        </button>
        <button
          onClick={() => void clear("jellyfin")}
          disabled={busy}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/50 transition hover:bg-white/5 disabled:opacity-50"
        >
          Clear saved Jellyfin
        </button>
        <button
          onClick={() => void clear("lidarr")}
          disabled={busy}
          className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/50 transition hover:bg-white/5 disabled:opacity-50"
        >
          Clear saved Lidarr
        </button>
      </div>

      <p className="text-xs leading-relaxed text-white/35">
        Keys are stored in the app&apos;s SQLite database on this machine, in plain text, and are
        never sent back to the browser — the API reports only that a key is set and its last four
        characters. This app has no login of its own, so anyone who can reach it can change these
        settings; keep it on your LAN or behind a reverse proxy.
      </p>
    </div>
  );
}
