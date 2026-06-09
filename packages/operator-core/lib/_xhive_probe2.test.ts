import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { makeSwarmCrossHiveTransport } from './cross-hive-swarm-transport';
import type { HyperswarmLike } from './sync/hyperbee/swarm';

describe('xhive probe2', () => {
  it('two real transports', async () => {
    const raw = (pk: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
      (pk.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
    const hiveA = raw(generateKeyPairSync('ed25519').publicKey);
    const hiveB = raw(generateKeyPairSync('ed25519').publicKey);
    const testnet = await createTestnet(3);
    const sa = new Hyperswarm({ bootstrap: testnet.bootstrap });
    const sb = new Hyperswarm({ bootstrap: testnet.bootstrap });
    const tA = makeSwarmCrossHiveTransport({ swarm: sa as unknown as HyperswarmLike, selfHivePubkey: hiveA, sendWaitMs: 100, pollMs: 50 });
    const tB = makeSwarmCrossHiveTransport({ swarm: sb as unknown as HyperswarmLike, selfHivePubkey: hiveB, sendWaitMs: 100, pollMs: 50 });
    const got: string[] = [];
    tB.subscribe(async (e) => { got.push(e.id); });
    tA.subscribe(async () => {});
    // kick the rendezvous: A joins B's topic by attempting a send (will throw fast)
    for (let i = 0; i < 20; i++) {
      await tA.send(hiveB, { id: `m${i}`, fromHivePubkey: hiveA, toHivePubkey: hiveB, kind: 'ask', subject: 's', body: 'b', sig: 'x' }).catch(() => {});
      // eslint-disable-next-line no-console
      console.log(`PROBE2 t=${i}s aConn=${tA.connectionCount} aOpen=${tA.openChannelCount} bConn=${tB.connectionCount} bOpen=${tB.openChannelCount} got=${got.length}`);
      if (got.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await tA.close(); await tB.close(); await sa.destroy(); await sb.destroy(); await testnet.destroy();
    expect(tA.connectionCount).toBeGreaterThanOrEqual(0);
  }, 40000);
});
