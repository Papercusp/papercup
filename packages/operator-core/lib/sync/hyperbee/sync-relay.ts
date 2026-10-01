/**
 * Relay fallback for the shared sync swarm (WI-10004827).
 *
 * Two peers that cannot holepunch each other never connect directly: two
 * machines behind the same NAT whose router does not hairpin UDP, a
 * client-isolating guest Wi-Fi, CGNAT mobile peers, cloud VMs behind one Cloud
 * NAT. Measured 2026-10-01 with two netns behind one MASQUERADE uplink: stock
 * hyperdht aborts with HOLEPUNCH_ABORTED every time, so without a relay those
 * peers silently never replicate.
 *
 * Voice already solves this with blind-relay servers passed as hyperswarm's
 * `relayThrough` (voice-node/voice-relay.ts). A blind relay forwards an
 * end-to-end encrypted hyperdht stream without reading it, so the same relay
 * set serves sync traffic too; this module reuses it rather than adding a
 * second relay registry.
 *
 * Fallback-only is hyperswarm's own semantics for a static key list (checked
 * against hyperswarm 4.17.0, `toRelayFunction` + `shouldForceRelaying`): the
 * relays are used only when a direct connect failed with HOLEPUNCH_ABORTED,
 * HOLEPUNCH_DOUBLE_RANDOMIZED_NATS or REMOTE_NOT_HOLEPUNCHABLE, or when this
 * node's own NAT is randomized. A reachable peer still connects directly.
 * sync-relay.test.ts pins that behaviour against the real module so an upgrade
 * that changes it fails loudly.
 */

import { getVoiceRelayKeys } from '../../voice-node/voice-relay';

/**
 * The `relayThrough` constructor option for the shared sync swarm. Omitted
 * entirely when no relay is configured: an empty array is truthy to hyperswarm,
 * so passing `[]` would make every forced retry "relay through nothing".
 */
export function syncRelayThroughOption(keys: readonly Buffer[]): { relayThrough?: Buffer[] } {
  return keys.length > 0 ? { relayThrough: [...keys] } : {};
}

/**
 * The relay keys for the sync swarm: the voice relay set (env
 * PAPERCUSP_VOICE_RELAY_KEYS ∪ PG voice_relay.relayKeys). Never throws: a read
 * failure must not block swarm construction, it only loses the fallback.
 */
export async function resolveSyncRelayKeys(
  read: () => Promise<Buffer[]> = getVoiceRelayKeys,
): Promise<Buffer[]> {
  try {
    return await read();
  } catch (e) {
    console.warn(
      `[swarm] ⚠ could not read relay keys — the sync swarm has NO relay fallback this boot: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}

/** One-line construction log so "can unreachable peers connect at all?" is visible. */
export function describeSyncRelayFallback(keys: readonly Buffer[]): string {
  return keys.length > 0
    ? `[swarm] relay fallback: ${keys.length} blind-relay key(s), used only after a direct holepunch fails`
    : '[swarm] relay fallback: NONE configured — peers that cannot holepunch (same NAT without hairpin, CGNAT) will never connect';
}
