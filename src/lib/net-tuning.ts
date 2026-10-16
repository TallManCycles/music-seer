import net from "node:net";

/**
 * Some dual-stack networks (notably Node on Windows) resolve AAAA records that
 * are unreachable and then fail *fast* under Happy Eyeballs instead of falling
 * back to IPv4, which takes out outbound fetch() calls to MusicBrainz/Lidarr.
 *
 * `auto` disables address autoselection on win32 only; `on`/`off` force it.
 */
export function tuneNetworking(): void {
  const mode = (process.env.MUSICSEER_NET_FAMILY_AUTOSELECT ?? "auto").toLowerCase();
  const disable = mode === "off" || (mode === "auto" && process.platform === "win32");
  if (disable && typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
  }
}
