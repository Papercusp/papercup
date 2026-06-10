import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const testnet = await createTestnet(3);
log('testnet up', testnet.bootstrap);

const A = new Hyperswarm({ bootstrap: testnet.bootstrap });
const B = new Hyperswarm({ bootstrap: testnet.bootstrap });
for (const [name, s] of [['A', A], ['B', B]]) {
  s.on('connection', (conn) => {
    log(`${name}: CONNECTION opened`);
    conn.on('error', () => {});
  });
}
const topic = randomBytes(32);
A.join(topic, { server: true, client: true });
B.join(topic, { server: true, client: true });

const t0 = Date.now();
const iv = setInterval(async () => {
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  log(`t=${el}s A: peers=${A.peers.size} conns=${A.connections.size} | B: peers=${B.peers.size} conns=${B.connections.size}`);
  if (A.connections.size > 0 && B.connections.size > 0) { log('SUCCESS'); process.exit(0); }
  if (Date.now() - t0 > 20_000) { log('TIMEOUT'); process.exit(1); }
}, 1000);
