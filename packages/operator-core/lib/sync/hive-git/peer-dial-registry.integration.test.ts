/**
 * peer-dial-registry.integration.test.ts — WI-3583: the device-pubkey →
 * live-swarm-socket registry over TWO REAL Protomux instances on a real
 * unix-socket pair (same substitution idiom as serve-wiring.integration.test.ts
 * — standing in for the hive-swarm connection). Proves the hello handshake
 * populates the registry on BOTH sides, that it coexists on the SAME muxer as
 * serve-wiring.ts's own six-slot channel without collision, that a resolved
 * device dials a REAL fetch end to end, and that an unknown device fails soft
 * (never throws) exactly like `openHiveGitFetchDuplex`'s own contract.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/peer-dial-registry.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import Protomux from 'protomux';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes, same pattern as serve-wiring.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { defaultRunGit, ensureHiveGitRepo } from './storage';
import { fetchOverDuplex } from './fetch-transport';
import { wireHiveGitServe } from './serve-wiring';
import { setHiveGitMode, getHiveGitMode } from '../../harness/git-sync/hive-git-mode';
import { wireHiveGitDial, resolveHiveGitPeerSocket, openHiveGitDuplexToDevice, _testing } from './peer-dial-registry';

const WORKSPACE_ID = `ws-dial-registry-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-dial-registry-${randomUUID().slice(0, 8)}`;
const TOPIC = Buffer.alloc(32, 11); // a fixed 32-byte stand-in for the hive topic
const FAKE_PUBKEY = Buffer.alloc(32, 13).toString('base64');
const SERVER_DEVICE = Buffer.alloc(32, 1).toString('base64');
const CLIENT_DEVICE = Buffer.alloc(32, 2).toString('base64');

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

/**
 * WI-3583 diagnosis: a RAW `node:net.Socket` (this test's stand-in for the
 * real Hyperswarm/NoiseSecretStream connection) gives protomux NO message
 * framing guarantee — `Protomux._ondata` decodes exactly ONE message from
 * whatever bytes ONE 'data' event happens to deliver, with no loop over
 * leftover bytes. Two UNBATCHED `channel.open()` writes (from wireHiveGitServe
 * then wireHiveGitDial, called back-to-back) are two independent
 * `stream.write()` calls — the OS/loopback layer is free to coalesce them
 * into ONE 'data' event, which then silently DROPS the second channel's open
 * frame (never observed as an error, just an eternally-unopened channel).
 * This reproduced as real, non-deterministic hangs under fleet host load.
 * Real Hyperswarm connections don't have this problem (NoiseSecretStream
 * frames each message explicitly), so this is a TEST-fixture-only concern —
 * but the safe, general fix (also worth mirroring in production wiring that
 * ever calls multiple `wireX` functions back-to-back on one fresh socket) is
 * to CORK the shared mux around every `wireX` call on one connection, so
 * protomux batches them into ONE `_sendBatch` write — decoded via
 * `_onbatch`'s own loop over multiple messages per buffer, which is robust
 * regardless of how the transport chunks the underlying bytes.
 */
function wireAllCorked(socket: Duplex, wire: () => void): void {
  const muxStream = socket as unknown as { userData?: unknown };
  const mux = Protomux.from(muxStream as never);
  if (!muxStream.userData) muxStream.userData = mux;
  mux.cork();
  try {
    wire();
  } finally {
    mux.uncork();
  }
}

/**
 * WI-3583 diagnosis (root cause #4, continued): `wireAllCorked` above closes
 * the coalescing gap for the INITIAL corked batch of `channel.open()` calls,
 * but it does NOT — and structurally CANNOT — close it for messages sent
 * LATER, asynchronously, from an `onopen` callback (e.g. the hello-channel's
 * `maybeSendHello`) in response to the PEER's incoming batch arriving. That
 * later send is a lone, un-corked `stream.write()`, and it can still
 * coalesce at the OS/loopback layer with some OTHER write on the same raw
 * socket happening at nearly the same wall-clock moment (observed: a
 * peer's hello, sent synchronously from its own onopen while processing an
 * incoming batch, can arrive before OR merged with a write the other side
 * makes moments later — losing one message with zero error, exactly like
 * the original coalescing bug). Chasing every such site individually is
 * whack-a-mole; the actual, general, root-cause fix is to stop relying on
 * "one `stream.write()` == one peer-side 'data' event" from a raw
 * `node:net.Socket` AT ALL — that guarantee is real production's job
 * (`NoiseSecretStream` explicitly frames every message), not a raw
 * socket's. So: wrap the raw socket in a minimal length-prefixed framing
 * Duplex before handing it to Protomux, restoring exactly the invariant
 * Protomux already assumes its transport provides. This is transport-only
 * (no protocol/business-logic change) and is a strict superset guarantee of
 * `wireAllCorked`'s batching — every write, corked-batch or lone message
 * alike, now arrives atomically regardless of how many raw socket 'data'
 * events the OS happens to deliver it as, or how many separate writes get
 * physically coalesced into one.
 */
function frameWrap(raw: Socket): Duplex {
  let recvBuf: Buffer = Buffer.alloc(0);
  const wrapped: Duplex = new Duplex({
    read() {
      /* backpressure ignored — test-scale volumes only */
    },
    write(chunk: Buffer, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(buf.length, 0);
      // ONE Buffer.concat'd write — Node's stream internals may still split
      // this across multiple underlying syscalls, but never across two
      // logically-separate `wrapped.write()` calls, which is the only
      // coalescing this framing needs to defeat.
      raw.write(Buffer.concat([header, buf]), (err) => cb(err ?? null));
    },
    final(cb) {
      raw.end(() => cb());
    },
    destroy(err, cb) {
      raw.destroy(err ?? undefined);
      cb(err ?? null);
    },
  });
  raw.on('data', (data: Buffer) => {
    recvBuf = recvBuf.length ? Buffer.concat([recvBuf, data]) : data;
    while (recvBuf.length >= 4) {
      const len = recvBuf.readUInt32LE(0);
      if (recvBuf.length < 4 + len) break;
      wrapped.push(Buffer.from(recvBuf.subarray(4, 4 + len)));
      recvBuf = recvBuf.subarray(4 + len);
    }
  });
  raw.on('end', () => wrapped.push(null));
  raw.on('close', () => wrapped.push(null));
  raw.on('error', (e) => wrapped.destroy(e));
  return wrapped;
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('hive-git peer-dial-registry (WI-3583: device_pubkey -> live socket, over the hive-git-hello channel)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let clientSocket: Socket;
  let clientDuplex: Duplex;
  let sha = '';
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    await insertHiveIfAbsent({
      workspaceId: WORKSPACE_ID,
      homeSlug: HIVE,
      pubkeyBase64: FAKE_PUBKEY,
      keychainId: 'k-dial-registry',
    });

    root = await mkdtemp(join(tmpdir(), 'hgdial-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensureHiveGitRepo(HIVE, 'repo-1');
    clientRepo = await ensureHiveGitRepo(HIVE, 'repo-1-mirror');
    sha = await mintCommit(serverRepo, 'work 1');
    await defaultRunGit(['update-ref', 'refs/heads/work', sha], serverRepo);
    await setHiveGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getHiveGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      // Coexist on the SAME muxer as serve-wiring.ts's own six-slot channel —
      // proves the hello channel is genuinely additive, not a wire collision.
      // frameWrap (see its header) restores real production's per-write
      // message-atomicity guarantee; wireAllCorked's batching on top just
      // cuts syscalls, it's no longer load-bearing for correctness.
      const srvDuplex = frameWrap(srvConn);
      wireAllCorked(srvDuplex, () => {
        wireHiveGitServe(srvDuplex, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
        wireHiveGitDial(srvDuplex, TOPIC, SERVER_DEVICE);
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    clientSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
    clientDuplex = frameWrap(clientSocket);
    // Symmetric wiring — matches REAL production usage: swarm.ts's connection
    // handler calls wireHiveGitServe + wireHiveGitDial unconditionally on
    // EVERY peer connection (both the dialer and the acceptor side), never
    // just one. A client that wires wireHiveGitDial WITHOUT wireHiveGitServe
    // (this test's earlier, asymmetric fixture) has no `pair()` notifier
    // registered for HIVE_GIT_PROTOCOL — so the server's own hive-git-serve
    // channel's incoming "open" control frame (also on this shared muxer)
    // hits protomux's unregistered-protocol fallback and gets REJECTED,
    // which was starving the SEPARATE hello channel's own pairing on the
    // same connection (WI-3583 diagnosis).
    wireAllCorked(clientDuplex, () => {
      wireHiveGitServe(clientDuplex, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
      wireHiveGitDial(clientDuplex, TOPIC, CLIENT_DEVICE);
    });
  });

  afterAll(async () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    await setHiveGitMode(WORKSPACE_ID, HIVE, null);
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });

    if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
    else process.env.HARNESS_DATABASE_URL = prevAppUrl;
    if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  });

  it('the hello handshake learns the peer device_pubkey on BOTH sides', async () => {
    await waitFor(() => resolveHiveGitPeerSocket(TOPIC, SERVER_DEVICE) !== undefined);
    await waitFor(() => resolveHiveGitPeerSocket(TOPIC, CLIENT_DEVICE) !== undefined);
    // The client learned the SERVER's device from the client socket's own
    // perspective — resolving SERVER_DEVICE from this (single) process's
    // shared registry must yield a socket (either end, since both live in
    // the same process's module-level Map here).
    expect(resolveHiveGitPeerSocket(TOPIC, SERVER_DEVICE)).toBeDefined();
    expect(resolveHiveGitPeerSocket(TOPIC, CLIENT_DEVICE)).toBeDefined();
  });

  it('an unknown device fails soft — an immediately-destroyed duplex, never throws', async () => {
    const unknown = Buffer.alloc(32, 99).toString('base64');
    const duplex = await openHiveGitDuplexToDevice(TOPIC, unknown, { repoKey: 'repo-1' });
    expect(duplex.destroyed).toBe(true);
  });

  it('a resolved device dials a REAL fetch end to end (coexists with serve-wiring on the same muxer)', async () => {
    const duplex = await openHiveGitDuplexToDevice(TOPIC, SERVER_DEVICE, { repoKey: 'repo-1' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-dial-registry'], {
      timeoutMs: 30_000,
    });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-dial-registry'], clientRepo);
    expect(rev.stdout.trim()).toBe(sha);
  });

  it('a closed connection removes its registry entry', async () => {
    expect(resolveHiveGitPeerSocket(TOPIC, CLIENT_DEVICE)).toBeDefined();
    clientSocket.destroy();
    await waitFor(() => resolveHiveGitPeerSocket(TOPIC, CLIENT_DEVICE) === undefined);
  });
});

describe('hive-git peer-dial-registry unit-level (no swarm — direct registry manipulation)', () => {
  afterAll(() => {
    _testing.reset();
  });

  it('resolveHiveGitPeerSocket returns undefined for a topic with no registrations', () => {
    const topic = Buffer.alloc(32, 42);
    expect(resolveHiveGitPeerSocket(topic, 'anything')).toBeUndefined();
  });
});
