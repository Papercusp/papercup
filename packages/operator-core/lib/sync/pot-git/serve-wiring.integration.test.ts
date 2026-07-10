/**
 * serve-wiring.integration.test.ts — P-201 end to end: `wireHiveGitServe` +
 * `openHiveGitFetchDuplex` over TWO REAL Protomux instances on a
 * `@hyperswarm/secret-stream`-framed unix-socket pair (standing in for the
 * hive-swarm connection), driving a REAL `git upload-pack` ↔ `git fetch`
 * round trip (git on PATH, no swarm/DHT). Exercises the mode gate against the
 * REAL federated settings store (git-sync-action.ts's own dependency,
 * unmocked here on purpose).
 *
 * WHY SecretStream AND NOT A BARE net.Socket (WI-3490 live finding,
 * 2026-07-09): Protomux's own contract (its README: "By framed stream, it has
 * to be a stream that preserves the messages, ie something that length
 * prefixes like @hyperswarm/secret-stream") REQUIRES a message-framed
 * transport — a bare `net.Socket` is a raw byte stream with NO such
 * guarantee. Wiring `wireHiveGitServe`/`openHiveGitFetchDuplex` directly onto
 * raw sockets (the original shape of this test) reproduced a genuine, 100%
 * deterministic hang OUTSIDE vitest/PG too (a standalone tsx repro): two
 * small writes issued close together (the channel's "open" control message
 * immediately followed by the "req" data message) land in ONE 'data' event
 * on the receiving raw socket (confirmed via a `net.Socket.prototype.write`
 * + `Protomux.prototype._ondata` monkeypatch: a single 68-byte chunk = the
 * 55-byte open + the 13-byte req coalesced) — but `Protomux._ondata` decodes
 * only ONE message per 'data' event, so the coalesced `req` bytes are
 * silently never dispatched and `handleReq` never fires. This is a
 * TEST-HARNESS bug, not a `serve-wiring.ts` production bug: the real
 * hive-swarm connection's `noiseStream` already provides this framing
 * natively, so production is unaffected. Wrapping each raw socket end in a
 * `SecretStream(isInitiator, rawSocket)` (already a transitive dependency via
 * `apps/operator`'s `hyperswarm`/`corestore`/`hyperbee` deps — same hoisted-
 * import pattern `lib/sync/hyperbee/swarm.ts` already relies on for
 * `protomux`/`corestore`) reproduces the REAL connection's framing and the
 * hang disappears (confirmed via the same standalone repro).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/serve-wiring.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import SecretStream from '@hyperswarm/secret-stream';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same pattern as _baseline-coord-fixture.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { defaultRunGit, ensurePotGitRepo } from './storage';
import { fetchOverDuplex } from './fetch-transport';
import { wireHiveGitServe, openHiveGitFetchDuplex } from './serve-wiring';
import { setHiveGitMode, getHiveGitMode } from '../../harness/git-sync/hive-git-mode';

const WORKSPACE_ID = `ws-serve-wiring-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-serve-wiring-${randomUUID().slice(0, 8)}`;
const TOPIC = Buffer.alloc(32, 7); // a fixed 32-byte stand-in for the hive topic
// A fake-but-valid raw-32-byte Ed25519 pubkey — setHiveGitMode/setHiveSetting
// enforce a real Hive row exists (getHiveBySlug), same fixture idiom as
// hive-settings-store.integration.test.ts's own `pk()` helper.
const FAKE_PUBKEY = Buffer.alloc(32, 9).toString('base64');

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

describe('pot-git serve-wiring (P-201: serveUploadPack over the papercusp/pot-git Protomux channel)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let clientSocket: Socket;
  let clientNoise: InstanceType<typeof SecretStream>;
  let sha = '';
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    // `wireHiveGitServe`'s internal mode-check (serve-wiring.ts) calls
    // getHiveGitMode with NO sql override — it always reads through the
    // ambient getOrgPg() singleton (the one real pool in production). So a
    // Hive row created in an ISOLATED createOrgTestDb() container would be
    // invisible to it. Fix: env-route getOrgPg() itself at this throwaway
    // migrated DB (the `_baseline-coord-fixture.ts` pattern) so every no-sql
    // call in this test — ours AND serve-wiring.ts's internal one — resolves
    // to the SAME database.
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    // The throwaway container has no PgBouncer in front; on a server-class dev
    // box getOrgPg()'s pgbouncer rewrite would otherwise redirect these reads
    // to the box's OWN pooler (wrong Postgres entirely) — same guard
    // _baseline-coord-fixture.ts uses.
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    // A Hive row must exist — setHiveSetting/setHiveGitMode enforce the
    // logical scope via getHiveBySlug (same fixture idiom as
    // hive-settings-store.integration.test.ts). No explicit `sql` — this
    // goes through the now env-routed getOrgPg(), same as production.
    await insertHiveIfAbsent({
      workspaceId: WORKSPACE_ID,
      homeSlug: HIVE,
      pubkeyBase64: FAKE_PUBKEY,
      keychainId: 'k-serve-wiring',
    });

    root = await mkdtemp(join(tmpdir(), 'hgserve-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo(HIVE, 'repo-1');
    clientRepo = await ensurePotGitRepo(HIVE, 'repo-1-mirror');
    sha = await mintCommit(serverRepo, 'work 1');
    await defaultRunGit(['update-ref', 'refs/heads/work', sha], serverRepo);
    await setHiveGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getHiveGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');

    sockPath = join(root, 'link.sock');
    // allowHalfOpen:true on BOTH ends — a FIN on one leg must not tear down the
    // socket before its buffered bytes flush (same reasoning as fetch-transport's
    // own link; here it also carries the Protomux muxer for BOTH channels).
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      // Protomux requires a MESSAGE-FRAMED stream (its own README: "it has to
      // be a stream that preserves the messages, ie something that length
      // prefixes like @hyperswarm/secret-stream") — a bare net.Socket does
      // NOT preserve message boundaries (two small writes issued close
      // together can coalesce into one 'data' event, silently dropping the
      // second message — see the module header, WI-3490). Wrap with a real
      // SecretStream, exactly mirroring what the real hive-swarm connection's
      // `noiseStream` already provides in production.
      const srvNoise = new SecretStream(false, srvConn);
      wireHiveGitServe(srvNoise, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    clientSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
    clientNoise = new SecretStream(true, clientSocket);
    await clientNoise.opened;
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

    // Restore the ambient getOrgPg() routing + tear down the throwaway DB —
    // must run AFTER the last no-sql call above, and must leave no cached
    // pool pointed at a container we're about to drop.
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

  it('fetches the served repo end to end (real git upload-pack, real git fetch)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/work'], {
      timeoutMs: 30_000,
    });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/work'], clientRepo);
    expect(rev.stdout.trim()).toBe(sha);
    const cat = await defaultRunGit(['cat-file', '-e', sha], clientRepo);
    expect(cat.code).toBe(0);
  });

  it('a legacy-mode hive REFUSES — never serves a byte (mode re-checked live, no re-seed needed)', async () => {
    await setHiveGitMode(WORKSPACE_ID, HIVE, 'legacy');
    try {
      const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
      const res = await fetchOverDuplex(
        clientRepo,
        duplex,
        ['+refs/heads/work:refs/heads/other-legacy-attempt'],
        { timeoutMs: 15_000 },
      );
      expect(res.code).not.toBe(0);
    } finally {
      await setHiveGitMode(WORKSPACE_ID, HIVE, 'bridged');
    }
  });

  it('refuses an unknown repoKey', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'not-a-real-repo' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never'], {
      timeoutMs: 15_000,
    });
    expect(res.code).not.toBe(0);
  });

  it('refuses a path-traversal repoKey (defense in depth — never touches the fs outside the root)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: '../../etc' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never2'], {
      timeoutMs: 15_000,
    });
    expect(res.code).not.toBe(0);
  });
});
