/** THROWAWAY probe — diagnoses late invite-topic channel pairing; delete after use. */
import { afterEach, describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { createDirectoryGossip } from '../directory-swarm';
import type { HyperswarmLike } from '../swarm';
import type { SignedHiveAnnounce } from '../hive-announce';

const OUT = '/tmp/probe-results.txt';
const log = (s: string): void => appendFileSync(OUT, `${s}\n`);

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

describe('probe: late invite-topic pairing', () => {
  it('late join pairs and delivers', { timeout: 60_000 }, async () => {
    const testnet = await createTestnet(3);
    cleanups.push(() => testnet.destroy());
    const mk = (): HyperswarmLike => {
      const s = new Hyperswarm({ bootstrap: testnet.bootstrap });
      cleanups.push(async () => {
        try {
          await (s as unknown as { destroy(): Promise<void> }).destroy();
        } catch {
          /* ignore */
        }
      });
      return s as unknown as HyperswarmLike;
    };
    const swarmA = mk();
    const swarmB = mk();

    const globalTopic = Buffer.alloc(32, 1);
    const inviteTopic = Buffer.alloc(32, 2);
    const gHex = globalTopic.toString('hex');
    const iHex = inviteTopic.toString('hex');
    const frameFor = (hex: string): SignedHiveAnnounce =>
      ({ hive_id: hex === gHex ? 'pub' : 'inv' }) as unknown as SignedHiveAnnounce;

    const gotB: string[] = [];
    const gA = createDirectoryGossip({
      swarm: swarmA,
      onAnnounce: () => {},
      getOwnAnnounces: (hex) => {
        log(`A getOwnAnnounces for ${hex === gHex ? 'GLOBAL' : hex === iHex ? 'INVITE' : 'OTHER'}`);
        return [frameFor(hex)];
      },
      refreshMs: 1000,
    });
    cleanups.push(() => gA.close());
    const gB = createDirectoryGossip({
      swarm: swarmB,
      onAnnounce: (f) => {
        gotB.push((f as { hive_id: string }).hive_id);
        log(`B got frame ${(f as { hive_id: string }).hive_id}`);
      },
      getOwnAnnounces: () => [],
      refreshMs: 1000,
    });
    cleanups.push(() => gB.close());

    gA.joinTopic(globalTopic);
    gA.joinTopic(inviteTopic);
    gB.joinTopic(globalTopic);

    // Phase 1: wait for the global frame on B.
    const d1 = Date.now() + 15_000;
    while (!gotB.includes('pub') && Date.now() < d1) await new Promise((r) => setTimeout(r, 200));
    log(
      `phase1: gotB=${JSON.stringify(gotB)} A(conn=${gA.connectionCount} g=${gA.openChannelCount(gHex)} i=${gA.openChannelCount(iHex)}) B(conn=${gB.connectionCount} g=${gB.openChannelCount(gHex)})`,
    );

    // Phase 2: B joins the invite topic late.
    gB.joinTopic(inviteTopic);
    const d2 = Date.now() + 15_000;
    while (!gotB.includes('inv') && Date.now() < d2) await new Promise((r) => setTimeout(r, 200));
    log(
      `phase2: gotB=${JSON.stringify(gotB)} A(conn=${gA.connectionCount} g=${gA.openChannelCount(gHex)} i=${gA.openChannelCount(iHex)}) B(conn=${gB.connectionCount} g=${gB.openChannelCount(gHex)} i=${gB.openChannelCount(iHex)})`,
    );
  });
});
