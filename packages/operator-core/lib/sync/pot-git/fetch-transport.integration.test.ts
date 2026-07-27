/**
 * fetch-transport.integration.test.ts — G-2 native git protocol-v2 fetch over a
 * duplex, end to end with REAL bare repos + REAL upload-pack/fetch (git on PATH,
 * no network, no swarm). The duplex is a plain unix-socket connection standing in
 * for a per-fetch Protomux sub-stream, so the whole transport path runs offline:
 *
 *   git fetch (client) → ext bridge → unix sock → clientConn ⇄ srvConn →
 *   serveUploadPack → git upload-pack (server).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/fetch-transport.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import {
  defaultRunGit,
  ensurePotGitRepo,
  writeNamespaceRef,
  readNamespaceRef,
} from './storage';
import {
  serveUploadPack,
  fetchOverDuplex,
  fetchPeerNamespace,
  peerNamespaceRefspec,
} from './fetch-transport';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

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

/** Stand up a unix-socket "link": each `connect` yields a duplex whose peer end
 *  is handed to serveUploadPack against `serverRepo`. Returns a connect() that
 *  gives the CLIENT-side duplex. */
function makeLink(serverRepo: string, sockPath: string): { server: Server; dialClient: () => Promise<Socket> } {
  // allowHalfOpen:true on BOTH ends — the duplex must survive a one-directional
  // FIN so the in-band-delimited pack flushes fully (see fetch-transport.ts).
  const server = createServer({ allowHalfOpen: true }, (srvConn) => {
    srvConn.on('error', () => {});
    void serveUploadPack(serverRepo, srvConn);
  });
  return {
    server,
    dialClient: () =>
      new Promise<Socket>((resolve, reject) => {
        const s = connect({ path: sockPath, allowHalfOpen: true });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      }),
  };
}

describe('pot-git fetch transport (real upload-pack ↔ fetch over a duplex)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let dialClient: () => Promise<Socket>;
  const devA = devicePubkey();
  let workSha = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgxport-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo('hive-x', 'repo-1');
    clientRepo = await ensurePotGitRepo('hive-x', 'repo-1-mirror');
    // The server (device A) writes a commit into its OWN namespace.
    workSha = await mintCommit(serverRepo, 'A work 1');
    await writeNamespaceRef(serverRepo, devA, 'refs/heads/work', workSha);
    sockPath = join(root, 'link.sock');
    const link = makeLink(serverRepo, sockPath);
    server = link.server;
    dialClient = link.dialClient;
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
  });

  afterAll(async () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('peerNamespaceRefspec forces the peer namespace subtree onto itself', () => {
    const rs = peerNamespaceRefspec(devA);
    expect(rs.startsWith('+refs/namespaces/')).toBe(true);
    const hex = rs.slice(1).split(':')[0].replace('/*', '');
    expect(rs).toBe(`+${hex}/*:${hex}/*`);
  });

  it('fetches a peer device namespace into the local mirror (objects + ref transfer)', async () => {
    // The mirror has nothing yet.
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBeNull();
    const conn = await dialClient();
    const res = await fetchPeerNamespace(clientRepo, conn, devA, { timeoutMs: 30_000 });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    // The namespace ref + its object are now in the mirror's ODB.
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBe(workSha);
    const cat = await defaultRunGit(['cat-file', '-e', workSha], clientRepo);
    expect(cat.code).toBe(0);
  });

  it('an advanced peer head incrementally fetches (only the new commit)', async () => {
    // Advance A's namespace head to a child commit.
    const child = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', `${workSha}^{tree}`, '-p', workSha, '-m', 'A work 2'],
      serverRepo,
    );
    expect(child.code, child.stderr).toBe(0);
    const sha2 = child.stdout.trim();
    await writeNamespaceRef(serverRepo, devA, 'refs/heads/work', sha2, defaultRunGit, workSha);
    const conn = await dialClient();
    const res = await fetchOverDuplex(clientRepo, conn, [peerNamespaceRefspec(devA)], { timeoutMs: 30_000 });
    expect(res.code, res.stderr).toBe(0);
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBe(sha2);
  });

  /**
   * EI-18765930091826096 recurrence guard: fetchOverDuplex OWNS the duplex.
   *
   * The ABANDONED path is the only one that distinguishes this, which is exactly
   * why the leak survived so long. On a HEALTHY fetch both halves of the duplex
   * are ended by the pipes anyway (the peer's end-frame ends the readable side,
   * `conn.pipe(duplex)` ends the writable side), so node auto-destroys it and an
   * `expect(duplex.destroyed)` there passes with the release REVERTED — a
   * vacuous assertion, confirmed by mutation testing.
   *
   * Here nothing ever answers, so the ceiling is the only thing that can settle
   * the fetch and NOTHING else can end the duplex. In production that duplex is
   * a pot-git FrameDuplex whose write-end sends the `end` frame that reaps the
   * peer's `git upload-pack`, and whose close releases the session that would
   * otherwise keep absorbing the peer's pack forever.
   */
  it('EI-18765930091826096: a fetch that gives up RELEASES its duplex (the peer must be told, or its upload-pack never stops)', async () => {
    const stalled = new PassThrough();
    const res = await fetchOverDuplex(clientRepo, stalled, [peerNamespaceRefspec(devA)], {
      timeoutMs: 750,
    });
    expect(res.timedOut, res.stderr).toBe(true);
    // Ending the write side is what reaches the peer; destroying is what frees
    // the session. Assert both, since they fix different halves of the leak.
    expect(stalled.writableEnded, 'the peer was never told we gave up').toBe(true);
    await vi.waitFor(() => expect(stalled.destroyed, 'the duplex was never released').toBe(true), {
      timeout: 5_000,
    });
  });

  it('serveUploadPack refuses a repo outside the pot-git root (defense in depth)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hgoutside-'));
    try {
      // A throwaway duplex — the guard should fire before any git runs.
      const res = await serveUploadPack(outside, new PassThrough());
      expect(res.code).toBe(-1);
      expect(res.stderr).toMatch(/outside the pot-git root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
