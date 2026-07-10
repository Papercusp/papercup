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
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  ensurePotGitRepo,
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
    peerRepo = await ensurePotGitRepo('hive-x', 'repo-1');
    joinerRepo = await ensurePotGitRepo('hive-x', 'repo-1-joiner');

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

  it('REGRESSION (WI-1559): the joiner OWN namespace is never seeded from a peer (squat refusal)', async () => {
    // A truly-fresh joiner, and a peer that SQUATS the joiner's own device
    // namespace — pre-planting refs that would masquerade as the joiner's own
    // work before its first publish.
    const devSelf = devicePubkey();
    const squat = await mintCommit(peerRepo, 'squatting the joiner own namespace');
    await writeNamespaceRef(peerRepo, devSelf, WORK_REF, squat);

    const joiner2 = await ensurePotGitRepo('hive-x', 'repo-1-joiner2');
    expect(await listNamespaces(joiner2)).toEqual([]);
    const res = await bootstrapFromPeer(joiner2, await dial(), {
      timeoutMs: 30_000,
      selfDevicePubkey: devSelf,
    });
    expect(res.ok, res.stderr).toBe(true);

    const selfKey = deviceNamespaceKey(devSelf);
    expect(res.skippedSelf).toBe(selfKey);
    // The squat was refused: nothing under the joiner's own namespace…
    expect(await listNamespaceRefs(joiner2, devSelf)).toEqual([]);
    expect(res.namespaces).not.toContain(selfKey);
    // …while everyone ELSE's namespaces seeded normally on the fresh joiner.
    for (const dev of [devA, devB, devC, devIntegrator]) {
      expect(res.namespaces).toContain(deviceNamespaceKey(dev));
    }
    expect(res.skippedExisting).toEqual([]);
  });

  it('REGRESSION (WI-1558): a namespace created CONCURRENTLY mid-run is never clobbered (create-only CAS + rollback)', async () => {
    // The TOCTOU window: preExisting snapshots BEFORE the (possibly long)
    // fetch; the verified announcement pipeline (G-3/G-4) can create the
    // namespace in between. The old plain update-ref clobbered its verified
    // ref with the peer's UNVERIFIED quarantined sha.
    const joiner3 = await ensurePotGitRepo('hive-x', 'repo-1-joiner3');
    const devAKey = deviceNamespaceKey(devA);
    const sigrefsRef = `refs/namespaces/${devAKey}/refs/rad/sigrefs`;
    const pipelineSha = await mintCommit(joiner3, 'verified pipeline write, mid-bootstrap');

    // devA's group seeds refs/heads/work first (ref sort order), then
    // refs/rad/sigrefs. Fire the "pipeline" write just before the sigrefs CAS
    // so the seed loses the race AFTER a partial seed — exercising rollback.
    let fired = false;
    const racyRunGit: RunGit = async (args, cwd) => {
      if (!fired && cwd === joiner3 && args[0] === 'update-ref' && args[1] === sigrefsRef) {
        fired = true;
        const w = await defaultRunGit(['update-ref', sigrefsRef, pipelineSha], joiner3);
        expect(w.code, w.stderr).toBe(0);
      }
      return defaultRunGit(args, cwd);
    };

    const res = await bootstrapFromPeer(joiner3, await dial(), { timeoutMs: 30_000, runGit: racyRunGit });
    expect(fired).toBe(true);
    // Losing the CAS to the pipeline is NOT a failure…
    expect(res.ok, res.stderr).toBe(true);
    // …the pipeline's verified ref survives at ITS sha (never clobbered)…
    const at = await defaultRunGit(['rev-parse', '--verify', sigrefsRef], joiner3);
    expect(at.stdout.trim()).toBe(pipelineSha);
    // …this run's PARTIAL seed of the namespace was rolled back wholesale…
    expect(await readNamespaceRef(joiner3, devA, WORK_REF)).toBeNull();
    expect(res.skippedExisting).toContain(devAKey);
    // …and unrelated namespaces still seeded normally.
    for (const dev of [devB, devC, devIntegrator]) {
      expect(res.namespaces).toContain(deviceNamespaceKey(dev));
    }
  });
});
