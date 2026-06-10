import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const testnet = await createTestnet(3);
log('testnet up', testnet.bootstrap);

const A = new Hyperswarm({ bootstrap: testnet.bootstrap });
const B = new Hyperswarm({ bootstrap: testnet.bootstrap });
A.on('connection', (c) => { log('A conn'); c.on('error', () => {}); });
B.on('connection', (c) => { log('B conn'); c.on('error', () => {}); });

const topic = randomBytes(32);
const dA = A.join(topic, { server: true, client: true });
const dB = B.join(topic, { server: true, client: true });

log('A dht bootstrapped?', !!A.dht.bootstrapped, 'B:', !!B.dht.bootstrapped);
await Promise.race([
  Promise.all([dA.flushed(), dB.flushed()]).then(() => log('both discoveries flushed')),
  new Promise((r) => setTimeout(() => { log('flushed() TIMED OUT after 15s'); r(); }, 15000)),
]);
log('A peers', A.peers.size, 'B peers', B.peers.size, 'A conns', A.connections.size);

// manual lookup from a fresh testnet node
const node = testnet.createNode();
await node.ready?.();
let found = 0;
try {
  const q = node.lookup(topic);
  for await (const reply of q) {
    found += reply.peers?.length ?? 0;
    log('lookup reply from', reply.from?.port, 'peers:', (reply.peers ?? []).map((p) => p.publicKey?.toString('hex').slice(0, 8)));
  }
} catch (e) { log('lookup error', e.message); }
log('lookup done, total announce peers found:', found);
await new Promise((r) => setTimeout(r, 3000));
log('final: A conns', A.connections.size, 'B conns', B.connections.size);
process.exit(0);
