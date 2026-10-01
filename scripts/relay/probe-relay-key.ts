/**
 * Probe relay keys on the PUBLIC DHT and print one verdict per key
 * (plan public-blind-relay-2026-10-01, R-2). Same probe the boot liveness check
 * runs (sync-relay.ts probeRelayKey): live / not-found / unknown.
 *
 * usage: npx tsx scripts/relay/probe-relay-key.ts [<hex key> ...]
 *        (no keys → the shipped DEFAULT_RELAY_KEYS)
 * exit:  0 every key live · 1 some key not-found · 2 some key unknown (DHT unreachable / timeout)
 */
/// <reference path="../../packages/operator-core/lib/sync/hyperbee/holepunch.d.ts" />
import DHT from 'hyperdht';
import { isCliEntry } from '../../packages/operator-core/lib/util/cli-entry';
import { probeRelayKey, type RelayLookupDht } from '../../packages/operator-core/lib/sync/hyperbee/sync-relay';
import { DEFAULT_RELAY_KEYS } from '../../packages/operator-core/lib/voice-node/voice-relay';

export async function main(keysHex: readonly string[]): Promise<number> {
  const keys = keysHex.length > 0 ? keysHex : DEFAULT_RELAY_KEYS;
  const dht = new (DHT as unknown as new () => RelayLookupDht & { ready(): Promise<void>; destroy(): Promise<void> })();
  let exit = 0;
  try {
    await dht.ready();
    for (const hex of keys) {
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`not a 64-hex relay key: ${hex}`);
      const verdict = await probeRelayKey(dht, Buffer.from(hex, 'hex'));
      console.log(JSON.stringify({ key: hex.toLowerCase(), ...verdict }));
      if (verdict.status === 'unknown') exit = Math.max(exit, 2);
      else if (verdict.status === 'not-found') exit = Math.max(exit, 1);
    }
  } finally {
    await dht.destroy();
  }
  return exit;
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
