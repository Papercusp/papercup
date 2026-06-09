/** THROWAWAY probe — diagnoses the live directory gossip; delete after use. */
import { afterEach, describe, it, expect } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { createDirectoryGossip } from '../directory-swarm';
import { deriveDirectoryTopic } from '../derive-hive-topic';
import type { HyperswarmLike } from '../swarm';
import type { SignedHiveAnnounce } from '../hive-announce';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* ignore */
    }
  }
});

describe('probe', () => {
  it(
    'two gossips on one topic: connection + channel pairing + frame delivery',
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(() => testnet.destroy());

      const mk = (): HyperswarmLike & { destroy(): Promise<void>; flush(): Promise<unknown> } => {
        const s = new Hyperswarm({ bootstrap: testnet.bootstrap }) as never;
        cleanups.push(async () => {
          try {
            await (s as { destroy(): Promise<void> }).destroy();
          } catch {
            /* ignore */
          }
        });
        return s;
      };
      const swarmA = mk();
      const swarmB = mk();

      const fakeFrame = { hive_id: 'probe' } as unknown as SignedHiveAnnounce;
      const gotB: SignedHiveAnnounce[] = [];

      const gA = createDirectoryGossip({
        swarm: swarmA,
        onAnnounce: () => {},
        getOwnAnnounces: () => [fakeFrame],
        reflushMs: 1000,
      });
      cleanups.push(() => gA.close());
      const gB = createDirectoryGossip({
        swarm: swarmB,
        onAnnounce: (f) => {
          gotB.push(f);
        },
        getOwnAnnounces: () => [],
        reflushMs: 1000,
      });
      cleanups.push(() => gB.close());

      const topic = deriveDirectoryTopic();
      gA.joinTopic(topic);
      gB.joinTopic(topic);

      const deadline = Date.now() + 20_000;
      for (;;) {
        // eslint-disable-next-line no-console
        console.log(
          `[probe] A conn=${gA.connectionCount} ch=${gA.openChannelCount()} | B conn=${gB.connectionCount} ch=${gB.openChannelCount()} | B got=${gotB.length}`,
        );
        if (gotB.length > 0 || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(gotB.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
