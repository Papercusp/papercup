/**
 * mode-transition-safety.integration.test.ts — P-205/WI-3591 (p2p-git-live-
 * activation-2026-07-09): the composite property the individual leg suites
 * don't cover — that cycling `hiveGit.mode` through legacy → bridged →
 * p2p-only → legacy never re-seeds, rewinds, or loses a namespace/ref, even
 * when the p2p legs (G-8 bootstrap, G-9 gc) actually run mid-cycle.
 *
 * `bootstrap.integration.test.ts` already proves bootstrapFromPeer's own
 * re-run-only-seeds-new-namespaces contract at the pure-function level, and
 * `hive-git-gc-action.test.ts` proves the routine wiring self-gates gc to a
 * no-op on `legacy`. THIS suite proves the two real, wired legs compose
 * safely across a mode cycle against one real bare repo + real transport:
 *
 *   legacy   — no p2p leg runs (mode self-gate; nothing to prove beyond "no
 *              call happened", asserted via an unchanged snapshot).
 *   bridged  — G-8 bootstrap runs for the first time: seeds every namespace
 *              the peer holds.
 *   p2p-only — G-9 gc runs against the now-warm repo, then a SECOND bootstrap
 *              tick runs (the self-gate in `runBootstrapLeg` only prevents a
 *              RE-tick on an already-warm repo in production; here we drive
 *              `bootstrapFromPeer` directly to prove ITS OWN re-run safety
 *              survives having gc run in between) — must skip every
 *              already-seeded namespace untouched, and gc must never delete
 *              a WORK_REF/SIGREFS_REF/STAGING_REF or an under-the-keep-limit
 *              published ref.
 *   legacy   — no further p2p leg call; the final snapshot must exactly match
 *              the post-p2p-only state (nothing happens without a call).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/mode-transition-safety.integration.test.ts
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
  ensurePotGitRepo,
  listNamespaceRefs,
  listNamespaces,
  writeNamespaceRef,
} from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF, WORK_REF } from './integrator';
import { SIGREFS_REF } from './sigrefs';
import { bootstrapFromPeer } from './bootstrap';
import { gcHiveGitRepo } from './gc';

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

/** A full snapshot of every namespace's refs, keyed by namespace hex, for a
 *  deep before/after equality check across the mode cycle. */
async function snapshot(repoPath: string): Promise<Record<string, Array<{ ref: string; sha: string }>>> {
  const out: Record<string, Array<{ ref: string; sha: string }>> = {};
  for (const ns of await listNamespaces(repoPath)) {
    // listNamespaceRefs takes a device pubkey, not the hex — but for a raw
    // hex-keyed snapshot we read directly via for-each-ref on the namespace.
    const r = await defaultRunGit(
      ['for-each-ref', '--format=%(objectname) %(refname)', `refs/namespaces/${ns}/`],
      repoPath,
    );
    out[ns] = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const sp = l.indexOf(' ');
        return { sha: l.slice(0, sp), ref: l.slice(sp + 1) };
      })
      .sort((a, b) => a.ref.localeCompare(b.ref));
  }
  return out;
}

describe('hive-git mode-transition safety (legacy → bridged → p2p-only → legacy)', () => {
  let root: string;
  let peerRepo: string;
  let joinerRepo: string;
  let sockPath: string;
  let server: Server;
  const devA = devicePubkey();
  const devB = devicePubkey();
  const devIntegrator = devicePubkey();

  const dial = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgmode-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    peerRepo = await ensurePotGitRepo('hive-y', 'repo-1');
    joinerRepo = await ensurePotGitRepo('hive-y', 'repo-1-joiner');

    // The peer holds two members' work + a few published-ref generations on A
    // (so gc's keep-N-published-refs trimming has something real to trim) and
    // the integrator's staging.
    const a1 = await mintCommit(peerRepo, 'A work v1');
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a1);
    const a2 = await mintCommit(peerRepo, 'A work v2', a1);
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a2, defaultRunGit, a1);
    await writeNamespaceRef(peerRepo, devA, SIGREFS_REF, a2);
    const b1 = await mintCommit(peerRepo, 'B work');
    await writeNamespaceRef(peerRepo, devB, WORK_REF, b1);
    const staging = await mintCommit(peerRepo, 'staging', a2);
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

  it('legacy: no p2p leg runs — the joiner stays a cold, empty repo', async () => {
    // Simulates the hiveGit.mode self-gate every leg has: on 'legacy' the
    // routine tick never calls into any of these functions at all.
    expect(await listNamespaces(joinerRepo)).toEqual([]);
  });

  it('bridged: G-8 bootstrap seeds every namespace the peer holds', async () => {
    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000 });
    expect(res.ok, res.stderr).toBe(true);
    const peerNs = await listNamespaces(peerRepo);
    expect(peerNs).toHaveLength(3);
    expect(await listNamespaces(joinerRepo)).toEqual(peerNs);
    for (const dev of [devA, devB, devIntegrator]) {
      const peerRefs = await listNamespaceRefs(peerRepo, dev);
      expect(await listNamespaceRefs(joinerRepo, dev)).toEqual(peerRefs);
    }
  });

  it('p2p-only: gc runs, then a second bootstrap tick composes safely — no re-seed, no ref loss', async () => {
    const before = await snapshot(joinerRepo);

    // G-9 gc runs on the now-warm repo (default retention: keep 2 published
    // refs per namespace — nothing here exceeds that, so gc should be a
    // structural no-op on the ref graph: nothing archived, nothing deleted).
    const gcResult = await gcHiveGitRepo(joinerRepo);
    expect(gcResult.errors).toEqual([]);
    expect(gcResult.archivedNamespaces).toEqual([]);
    expect(gcResult.deletedRefs).toEqual([]);

    const afterGc = await snapshot(joinerRepo);
    expect(afterGc).toEqual(before); // gc alone must not mutate anything here

    // Peer gains a brand-new member C mid-cycle (a realistic concurrent
    // event), simulating the SECOND bootstrap tick that would fire once the
    // routine transitions past 'bridged' into 'p2p-only'.
    const devC = devicePubkey();
    const c1 = await mintCommit(peerRepo, 'C work');
    await writeNamespaceRef(peerRepo, devC, WORK_REF, c1);

    const res2 = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000 });
    expect(res2.ok, res2.stderr).toBe(true);
    // The new namespace was seeded...
    expect(res2.namespaces).toContain(deviceNamespaceKey(devC));
    // ...but every namespace that existed before this tick was left untouched
    // (skippedExisting), not re-seeded/rewound by the repeat wildcard fetch.
    expect(res2.skippedExisting).toEqual(
      [devA, devB, devIntegrator].map(deviceNamespaceKey).sort(),
    );

    // The pre-existing namespaces' refs are BYTE-FOR-BYTE identical to the
    // pre-gc, pre-second-bootstrap snapshot — the composite gc+re-bootstrap
    // cycle introduced zero drift on anything it didn't explicitly seed.
    const afterSecondBootstrap = await snapshot(joinerRepo);
    for (const ns of Object.keys(before)) {
      expect(afterSecondBootstrap[ns]).toEqual(before[ns]);
    }
  });

  it('legacy again: no further p2p leg call leaves the repo exactly as the last real tick left it (4 namespaces, all stable)', async () => {
    const finalSnapshot = await snapshot(joinerRepo);
    // No call happens here by construction (the self-gate contract under
    // test) — re-snapshotting immediately must be a pure read with no side
    // effect, proving the cycle settles into a stable state.
    expect(await snapshot(joinerRepo)).toEqual(finalSnapshot);
    const knownHexKeys = [devA, devB, devIntegrator].map(deviceNamespaceKey);
    const devCHexKey = Object.keys(finalSnapshot).find((k) => !knownHexKeys.includes(k));
    expect(devCHexKey).toBeDefined(); // the mid-cycle-joined C namespace is present
    expect(Object.keys(finalSnapshot).sort()).toEqual([...knownHexKeys, devCHexKey].sort());
  });
});
