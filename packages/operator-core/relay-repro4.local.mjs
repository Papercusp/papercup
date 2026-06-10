import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import DHT from 'hyperdht';
import { Server as BlindRelayServer } from 'blind-relay';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const testnet = await createTestnet(3);

const dht = new DHT({ bootstrap: testnet.bootstrap });
const relayServer = new BlindRelayServer({
  createStream: (so) => dht.createRawStream({ ...so, framed: true }),
});
const server = dht.createServer((socket) => {
  socket.on('error', () => {});
  relayServer.accept(socket, { id: socket.remotePublicKey });
});
const keyPair = DHT.keyPair(randomBytes(32));
await server.listen(keyPair);
const relayKey = keyPair.publicKey;
log('relay up');

const A = new Hyperswarm({ bootstrap: testnet.bootstrap, relayThrough: () => relayKey });
const B = new Hyperswarm({ bootstrap: testnet.bootstrap, relayThrough: () => relayKey });
let aConn = 0, bConn = 0;
A.on('connection', (c) => { aConn++; log('A conn open'); c.on('error', (e) => log('A conn err', e.code)); });
B.on('connection', (c) => { bConn++; log('B conn open'); c.on('error', (e) => log('B conn err', e.code)); });

const topic = randomBytes(32);
// SEQUENTIAL: A joins + announce flushes BEFORE B joins.
const dA = A.join(topic, { server: true, client: true });
await dA.flushed();
log('A announce flushed; now B joins');
B.join(topic, { server: true, client: true });

const t0 = Date.now();
while (aConn === 0 || bConn === 0) {
  if (Date.now() - t0 > 30_000) { log('TIMEOUT', aConn, bConn); process.exit(1); }
  await new Promise((r) => setTimeout(r, 200));
}
log(`both connected in ${Date.now() - t0}ms`);
log('relay stats', JSON.stringify(relayServer.stats));
process.exit(0);
