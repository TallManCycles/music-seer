import net from "node:net";
import dns from "node:dns";

/**
 * Some dual-stack networks (notably Node on Windows) resolve AAAA records that
 * are unreachable and then fail *fast* under Happy Eyeballs instead of falling
 * back to IPv4, which takes out outbound fetch() calls to MusicBrainz/Lidarr.
 *
 * `auto` disables address autoselection on win32 only; `on`/`off` force it.
 *
 * Containers are worth naming here: Docker's bridge network commonly has no
 * working IPv6 egress, so any host with AAAA records times out — that is what
 * broke the image build's `npm ci`, and it can break a third-party feed such as
 * the chart API. Set MUSICSEER_NET_FAMILY_AUTOSELECT=on there.
 */
export function tuneNetworking(): void {
  const mode = (process.env.MUSICSEER_NET_FAMILY_AUTOSELECT ?? "auto").toLowerCase();
  const disable = mode === "off" || (mode === "auto" && process.platform === "win32");
  if (disable && typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
  }
  // Address autoselection is only half of it: preferring IPv4 in DNS as well is
  // what actually stops a broken-IPv6 host from hanging. Safe everywhere — IPv6
  // is still used when no IPv4 address exists.
  if (disable) {
    try {
      dns.setDefaultResultOrder("ipv4first");
    } catch {
      /* older Node */
    }
  }
}
