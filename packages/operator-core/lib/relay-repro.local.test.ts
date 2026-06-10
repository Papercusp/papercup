import { randomBytes } from 'node:crypto';
import { it } from 'vitest';

it('minimal swarm pair on testnet', { timeout: 30_000 }, async () => {
  const { default: createTestnet } = await import('hyperdht/testnet.js') as any;
  const { default: Hyperswarm } = await import('hyperswarm') as any;
  const testnet = await createTestnet(3);
  const A = new Hyperswarm({ bootstrap: testnet.bootstrap });
  const B = new Hyperswarm({ bootstrap: testnet.bootstrap });
  let conns = 0;
  A.on('connection', (c: any) => { conns++; c.on('error', () => {}); });
  B.on('connection', (c: any) => { conns++; c.on('error', () => {}); });
  const topic = randomBytes(32);
  A.join(topic, { server: true, client: true });
  B.join(topic, { server: true, client: true });
  const t0 = Date.now();
  while (conns < 2) {
    if (Date.now() - t0 > 25_000) throw new Error(`timeout, conns=${conns} peersA=${A.peers.size} peersB=${B.peers.size}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  await A.destroy(); await B.destroy(); await testnet.destroy();
});
