import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import DHT from 'hyperdht';
import { Server as BlindRelayServer } from 'blind-relay';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const testnet = await createTestnet(3);
log('testnet up', testnet.bootstrap);

// --- relay server (same wiring as voice-relay.ts) ---
const seed = randomBytes(32);
const keyPair = DHT.keyPair(seed);
const dht = new DHT({ bootstrap: testnet.bootstrap });
const relayServer = new BlindRelayServer({
  createStream: (so) => dht.createRawStream({ ...so, framed: true }),
});
const server = dht.createServer((socket) => {
  socket.on('error', (e) => log('relay socket error', e?.message));
  relayServer.accept(socket, { id: socket.remotePublicKey });
});
await server.listen(keyPair);
const relayKey = keyPair.publicKey;
log('relay listening', relayKey.toString('hex'));

// --- two swarms with relayThrough fn ---
const mode = process.argv[2] ?? 'fn'; // fn | none
const mk = () =>
  new Hyperswarm({
    bootstrap: testnet.bootstrap,
    ...(mode === 'fn' ? { relayThrough: () => relayKey } : {}),
  });
const A = mk();
const B = mk();

for (const [name, s] of [['A', A], ['B', B]]) {
  s.on('connection', (conn, info) => {
    log(`${name}: CONNECTION opened (client=${info?.client})`);
    conn.on('error', (e) => log(`${name}: conn error`, e?.message, e?.code));
    conn.on('close', () => log(`${name}: conn close`));
  });
  s.dht.on('network-change', () => log(`${name}: network-change`));
}

const topic = randomBytes(32);
A.join(topic, { server: true, client: true });
B.join(topic, { server: true, client: true });

// Watch peer discovery + connection attempts
const t0 = Date.now();
const iv = setInterval(() => {
  const el = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `t=${el}s A: peers=${A.peers.size} connecting=${A.connecting} conns=${A.connections.size} stats=${JSON.stringify(A.stats.connects)} | B: peers=${B.peers.size} connecting=${B.connecting} conns=${B.connections.size}`,
  );
  log('relay stats', JSON.stringify(relayServer.stats));
  if (Date.now() - t0 > 30_000) {
    log('TIMEOUT - giving up');
    process.exit(1);
  }
  if (A.connections.size > 0 && B.connections.size > 0) {
    log('SUCCESS both connected');
    process.exit(0);
  }
}, 2000);
