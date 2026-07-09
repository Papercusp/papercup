/**
 * worktree-bridge-tick.integration.test.ts — P-204 driver: a BATCH of pending
 * staging-advance announcements processed in order, threading the running
 * watermark, with the continue-on-reject / stop-on-fetch-failure batch
 * contract (see worktree-bridge-tick.ts's module header).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/worktree-bridge-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensureHiveGitRepo, writeNamespaceRef } from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF } from './integrator';
import { type EpochSeq, type SignedStagingAdvance, signStagingAdvance } from './staging-advance';
import { runWorktreeBridgeTick } from './worktree-bridge-tick';

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function initWorktree(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.name', 't'], dir);
  await git(['config', 'user.email', 't@t'], dir);
}

function keypair() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

describe('worktree-bridge-tick (P-204: batch of pending staging-advance announcements)', () => {
  let root: string;
  let src: string;
  let peerRepo: string;
  let localMirror: string;
  let wt: string;
  let sockPath: string;
  let server: Server;
  let dials = 0;
  const integrator = keypair();
  let s1 = '';
  let s2 = '';
  let s3 = '';

  const openDuplex = (): Promise<Socket> => {
    dials++;
    return new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  };

  async function announce(epoch: number, seq: number, sha: string): Promise<SignedStagingAdvance> {
    return signStagingAdvance(
      { devicePubkeyBase64: integrator.pubkeyBase64, epoch, seq, stagingSha: sha, nowMs: 1_000 },
      integrator.sign,
    );
  }

  async function publishToPeer(sha: string, expectedOld?: string): Promise<void> {
    await git(['fetch', '-q', src, `+refs/heads/main:refs/bridge-src`], peerRepo);
    await writeNamespaceRef(peerRepo, integrator.pubkeyBase64, STAGING_REF, sha, defaultRunGit, expectedOld);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgbridgetick-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    src = join(root, 'src');
    await initWorktree(src);
    await writeFile(join(src, 'f.txt'), 'v1\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S1'], src);
    s1 = await git(['rev-parse', 'HEAD'], src);
    await writeFile(join(src, 'f.txt'), 'v2\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S2'], src);
    s2 = await git(['rev-parse', 'HEAD'], src);
    await writeFile(join(src, 'f.txt'), 'v3\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S3'], src);
    s3 = await git(['rev-parse', 'HEAD'], src);

    peerRepo = await ensureHiveGitRepo('hive-c', 'repo-int');
    localMirror = await ensureHiveGitRepo('hive-c', 'repo-local');
    await publishToPeer(s1);

    wt = join(root, 'wt');
    await initWorktree(wt);

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

  it('an empty batch is a fast no-op — ran:false, watermark unchanged', async () => {
    const prior = { epochSeq: null, stagingSha: null };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [],
      prior,
      accept: { expectedDevice: integrator.pubkeyBase64 },
      openDuplex,
    });
    expect(out).toEqual({ ran: false, results: [], watermark: prior, stoppedOnFetchFailure: false, errors: [] });
  });

  it('processes a batch of announcements in order, threading the watermark forward', async () => {
    await publishToPeer(s2, s1);
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [await announce(1, 1, s1), await announce(1, 2, s2)],
      prior: { epochSeq: null, stagingSha: null },
      accept: { expectedDevice: integrator.pubkeyBase64 },
      openDuplex,
    });
    expect(out.ran).toBe(true);
    expect(out.stoppedOnFetchFailure).toBe(false);
    expect(out.errors).toEqual([]);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].bridge.outcome).toBe('accepted');
    expect(out.results[1].bridge.outcome).toBe('accepted');
    expect(out.watermark).toEqual({ epochSeq: { epoch: 1, seq: 2 }, stagingSha: s2 });
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s2);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('a stale/replayed item in the middle of the batch is skipped, never starves the rest', async () => {
    await publishToPeer(s3, s2);
    const stale = await announce(1, 2, s2); // already-applied (epoch,seq) from the prior test
    const fresh = await announce(1, 3, s3);
    const priorWatermark = { epochSeq: { epoch: 1, seq: 2 }, stagingSha: s2 };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [stale, fresh],
      prior: priorWatermark,
      accept: { expectedDevice: integrator.pubkeyBase64 },
      openDuplex,
    });
    expect(out.ran).toBe(true);
    expect(out.stoppedOnFetchFailure).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[0].bridge).toEqual({ outcome: 'rejected', reason: 'stale-epoch-seq', preFetch: true });
    expect(out.results[1].bridge.outcome).toBe('accepted');
    expect(out.watermark).toEqual({ epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 });
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s3);
  });

  it('a fetch failure STOPS the batch — later pending items are not attempted this tick', async () => {
    const deadOpenDuplex = (): Promise<Socket> => Promise.reject(new Error('swarm unreachable'));
    const dialsBefore = dials;
    const priorWatermark = { epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 };
    // Two more (never-published) advances the dead transport would need to fetch.
    const a4 = await announce(1, 4, s3); // reuses s3's sha so it's a legal (no-op-content) advance if reached
    const a5 = await announce(1, 5, s3);
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [a4, a5],
      prior: priorWatermark,
      accept: { expectedDevice: integrator.pubkeyBase64 },
      openDuplex: deadOpenDuplex,
    });
    expect(out.ran).toBe(true);
    expect(out.stoppedOnFetchFailure).toBe(true);
    expect(out.results).toHaveLength(1); // stopped after the first fetch-failed item
    expect(out.results[0].bridge.outcome).toBe('fetch-failed');
    expect(out.errors.length).toBeGreaterThan(0);
    // Watermark unchanged — nothing was accepted this tick.
    expect(out.watermark).toEqual(priorWatermark);
    expect(dials).toBe(dialsBefore); // deadOpenDuplex never actually connects
  });

  it('omitting openDuplex serves from an already-current local mirror (integrator-machine path)', async () => {
    const wt2 = join(root, 'wt2');
    await initWorktree(wt2);
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror, // already holds s3 from earlier ticks
      worktreePath: wt2,
      pending: [await announce(1, 3, s3)],
      prior: { epochSeq: null, stagingSha: null },
      accept: { expectedDevice: integrator.pubkeyBase64 },
      // no openDuplex
    });
    expect(out.ran).toBe(true);
    expect(out.results[0].bridge.outcome).toBe('accepted');
    if (out.results[0].bridge.outcome === 'accepted') {
      expect(out.results[0].bridge.advance.outcome).toBe('advanced');
    }
    expect(await readFile(join(wt2, 'f.txt'), 'utf8')).toBe('v3\n');
  });

  it('a gate-less config throws immediately — the watermark-poisoning DoS stays unreachable', async () => {
    await expect(
      runWorktreeBridgeTick({
        bareRepoPath: localMirror,
        worktreePath: wt,
        pending: [await announce(1, 6, s3)],
        prior: { epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 },
        accept: {},
      }),
    ).rejects.toThrow(/device gate/);
  });
});
