/**
 * serve-wiring.integration.test.ts — P-201 end to end: `wireHiveGitServe` +
 * `openHiveGitFetchDuplex` over TWO REAL Protomux instances on a real
 * unix-socket pair (standing in for the hive-swarm connection — the same
 * substitution fetch-transport.integration.test.ts makes for a raw duplex),
 * driving a REAL `git upload-pack` ↔ `git fetch` round trip (git on PATH, no
 * swarm/DHT). Exercises the mode gate against the REAL federated settings
 * store (git-sync-action.ts's own dependency, unmocked here on purpose).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/serve-wiring.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { defaultRunGit, ensureHiveGitRepo } from './storage';
import { fetchOverDuplex } from './fetch-transport';
import { wireHiveGitServe, openHiveGitFetchDuplex } from './serve-wiring';
import { setHiveGitMode, getHiveGitMode } from '../../harness/git-sync/hive-git-mode';

const WORKSPACE_ID = `ws-serve-wiring-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-serve-wiring-${randomUUID().slice(0, 8)}`;
const TOPIC = Buffer.alloc(32, 7); // a fixed 32-byte stand-in for the hive topic

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

describe('hive-git serve-wiring (P-201: serveUploadPack over the papercusp/hive-git Protomux channel)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let clientSocket: Socket;
  let sha = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgserve-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensureHiveGitRepo(HIVE, 'repo-1');
    clientRepo = await ensureHiveGitRepo(HIVE, 'repo-1-mirror');
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
      wireHiveGitServe(srvConn, TOPIC, { hiveHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    clientSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
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
  });

  it('fetches the served repo end to end (real git upload-pack, real git fetch)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientSocket, TOPIC, { repoKey: 'repo-1' });
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
      const duplex = await openHiveGitFetchDuplex(clientSocket, TOPIC, { repoKey: 'repo-1' });
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
    const duplex = await openHiveGitFetchDuplex(clientSocket, TOPIC, { repoKey: 'not-a-real-repo' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never'], {
      timeoutMs: 15_000,
    });
    expect(res.code).not.toBe(0);
  });

  it('refuses a path-traversal repoKey (defense in depth — never touches the fs outside the root)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientSocket, TOPIC, { repoKey: '../../etc' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never2'], {
      timeoutMs: 15_000,
    });
    expect(res.code).not.toBe(0);
  });
});
