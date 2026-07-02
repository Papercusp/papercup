/**
 * bootstrap.integration.test.ts — G-8 cold-clone bootstrap (P-032): a fresh
 * empty repo seeds EVERY namespace a member peer holds, over the real G-2
 * transport (two bare repos + a socket duplex, the fetch-transport link
 * pattern). No swarm.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/bootstrap.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultRunGit,
  deviceNamespaceKey,
  ensureHiveGitRepo,
  listNamespaceRefs,
  listNamespaces,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF, WORK_REF } from './integrator';
import { bootstrapFromPeer } from './bootstrap';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function mintCommit(repoPath: string, msg: string, parent?: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim()];
  if (parent) args.push('-p', parent);
  args.push('-m', msg);
  const c = await defaultRunGit(args, repoPath);
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('bootstrap (G-8: one wildcard fetch seeds the whole hive repo)', () => {
  let root: string;
  let peerRepo: string;
  let joinerRepo: string;
  let sockPath: string;
  let server: Server;
  const devA = devicePubkey();
  const devB = devicePubkey();
  const devC = devicePubkey();
  const devIntegrator = devicePubkey();

  const dial = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgboot-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    peerRepo = await ensureHiveGitRepo('hive-x', 'repo-1');
    joinerRepo = await ensureHiveGitRepo('hive-x', 'repo-1-joiner');

    // The peer holds THREE device namespaces: two members' work (+ a sigrefs-
    // style extra ref on A) and the integrator's published staging.
    const a1 = await mintCommit(peerRepo, 'A work');
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a1);
    await writeNamespaceRef(peerRepo, devA, 'refs/rad/sigrefs', a1);
    const b1 = await mintCommit(peerRepo, 'B work');
    await writeNamespaceRef(peerRepo, devB, WORK_REF, b1);
    const staging = await mintCommit(peerRepo, 'staging', a1);
    await writeNamespaceRef(peerRepo, devIntegrator, STAGING_REF, staging);

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(peerRepo, srvConn);
    });
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

  it('a fresh joiner ends up with EVERY namespace the peer had (refs + objects)', async () => {
    expect(await listNamespaces(joinerRepo)).toEqual([]);
    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000 });
    expect(res.ok, res.stderr).toBe(true);

    const peerNs = await listNamespaces(peerRepo);
    expect(peerNs).toHaveLength(3);
    expect(res.namespaces).toEqual(peerNs);
    expect(await listNamespaces(joinerRepo)).toEqual(peerNs);

    // Every ref matches sha-for-sha, and the objects are really in the ODB.
    for (const dev of [devA, devB, devIntegrator]) {
      const peerRefs = await listNamespaceRefs(peerRepo, dev);
      const joinerRefs = await listNamespaceRefs(joinerRepo, dev);
      expect(peerRefs.length).toBeGreaterThan(0);
      expect(joinerRefs).toEqual(peerRefs);
      for (const { sha } of joinerRefs) {
        const cat = await defaultRunGit(['cat-file', '-e', `${sha}^{commit}`], joinerRepo);
        expect(cat.code, `object ${sha} missing after bootstrap`).toBe(0);
      }
    }
  });

  it('a re-run seeds only namespaces NEW on the peer; existing ones are skipped untouched', async () => {
    // After the first seed the peer gains a NEW member C, and member A advances.
    const c1 = await mintCommit(peerRepo, 'C work');
    await writeNamespaceRef(peerRepo, devC, WORK_REF, c1);
    const prev = await readNamespaceRef(peerRepo, devA, WORK_REF);
    expect(prev).not.toBeNull();
    const a2 = await mintCommit(peerRepo, 'A work 2', prev as string);
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a2, defaultRunGit, prev as string);

    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000 });
    expect(res.ok, res.stderr).toBe(true);
    // The NEW namespace was seeded…
    expect(await readNamespaceRef(joinerRepo, devC, WORK_REF)).toBe(c1);
    expect(res.namespaces).toContain(deviceNamespaceKey(devC));
    // …but A's EXISTING namespace was skipped: still at the first-seed sha.
    // Updates to existing namespaces flow via the verified announcement
    // pipeline (G-3/G-4), never via bootstrap.
    expect(await readNamespaceRef(joinerRepo, devA, WORK_REF)).toBe(prev);
    expect(res.skippedExisting).toEqual(
      [devA, devB, devIntegrator].map(deviceNamespaceKey).sort(),
    );
    // Quarantine left no debris behind.
    const leftover = await defaultRunGit(
      ['for-each-ref', '--format=%(refname)', 'refs/bootstrap-quarantine/'],
      joinerRepo,
    );
    expect(leftover.stdout.trim()).toBe('');
  });

  it('REGRESSION (HIGH): a re-run against a STALE peer never rewinds a locally-advanced namespace', async () => {
    // The joiner's A namespace advances LOCALLY (as the verified announcement
    // pipeline would move it — the G-4b sigrefs watermark now points past the
    // peer's stale view).
    const localPrev = await readNamespaceRef(joinerRepo, devA, WORK_REF);
    expect(localPrev).not.toBeNull();
    const j1 = await mintCommit(joinerRepo, 'A local-verified advance', localPrev as string);
    await writeNamespaceRef(joinerRepo, devA, WORK_REF, j1, defaultRunGit, localPrev as string);

    // The peer still serves its older view of A. The old forced wildcard
    // refspec force-rewound the joiner here; the quarantine+skip path must not.
    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000 });
    expect(res.ok, res.stderr).toBe(true);
    expect(await readNamespaceRef(joinerRepo, devA, WORK_REF)).toBe(j1); // NOT rewound
    expect(res.skippedExisting).toContain(deviceNamespaceKey(devA));
  });

  it('a dead duplex fails soft (ok:false), leaving the joiner intact for a retry', async () => {
    const { PassThrough } = await import('node:stream');
    const dead = new PassThrough();
    dead.end(); // nothing will ever answer
    const res = await bootstrapFromPeer(joinerRepo, dead, { timeoutMs: 3_000 });
    expect(res.ok).toBe(false);
    // Prior seeded state is untouched (3 first-seed namespaces + devC).
    expect((await listNamespaces(joinerRepo)).length).toBe(4);
  });
});
