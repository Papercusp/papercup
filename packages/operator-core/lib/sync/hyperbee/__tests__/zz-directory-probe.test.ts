/** THROWAWAY probe — bisects live hyperswarm discovery drivers; delete after use. */
import { afterEach, describe, it } from 'vitest';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

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

type Driver = 'dht-ready-then-join' | 'wait1500-then-join' | 'refresh-loop' | 'flushed-await';

async function probe(driver: Driver, topic: Buffer): Promise<string> {
  const testnet = await createTestnet(3);
  cleanups.push(() => testnet.destroy());
  const mk = () => {
    const s = new Hyperswarm({ bootstrap: testnet.bootstrap });
    cleanups.push(async () => {
      try {
        await s.destroy();
      } catch {
        /* ignore */
      }
    });
    return s;
  };
  const a = mk();
  const b = mk();
  let conns = 0;
  for (const s of [a, b]) {
    s.on('connection', (sock: { on(e: string, f: (x?: unknown) => void): void }) => {
      conns++;
      sock.on('error', () => {});
    });
  }

  const start = Date.now();
  if (driver === 'dht-ready-then-join') {
    await a.dht.ready();
    await b.dht.ready();
  }
  if (driver === 'wait1500-then-join') {
    await new Promise((r) => setTimeout(r, 1500));
  }
  const discos = [a, b].map((s) => s.join(topic, { server: true, client: true }));
  if (driver === 'flushed-await') {
    await Promise.all(discos.map((d) => d.flushed().catch(() => {})));
    // eslint-disable-next-line no-console
    console.log(`[probe] driver=${driver} flushed resolved at ${Date.now() - start}ms`);
  }
  let loop: ReturnType<typeof setInterval> | null = null;
  if (driver === 'refresh-loop') {
    loop = setInterval(() => {
      for (const d of discos) void (d as { refresh?: (o?: object) => Promise<unknown> }).refresh?.()?.catch?.(() => {});
    }, 1000);
    cleanups.push(() => {
      if (loop) clearInterval(loop);
    });
  }

  const deadline = Date.now() + 8000;
  while (conns < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (loop) clearInterval(loop);
  const verdict = conns >= 2 ? `CONNECTED in ${Date.now() - start}ms` : `NO CONNECTION after 8s (conns=${conns})`;
  (await import('node:fs')).appendFileSync('/tmp/probe-results.txt', `driver=${driver} -> ${verdict}\n`);
  return verdict;
}

describe('probe: discovery drivers round 2', () => {
  const topic = Buffer.alloc(32, 7);
  it('dht-ready-then-join', { timeout: 40_000 }, async () => {
    await probe('dht-ready-then-join', topic);
  });
  it('wait1500-then-join', { timeout: 40_000 }, async () => {
    await probe('wait1500-then-join', topic);
  });
  it('refresh-loop', { timeout: 40_000 }, async () => {
    await probe('refresh-loop', topic);
  });
  it('flushed-await', { timeout: 40_000 }, async () => {
    await probe('flushed-await', topic);
  });
});
