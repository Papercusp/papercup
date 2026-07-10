/**
 * worktree-bridge.integration.test.ts — G-7 end to end (P-031): a SIGNED
 * staging-advance announcement drives fetch (real upload-pack over a socket
 * duplex, the G-2 path) → mirror acceptance (G-5d fence) → object-bridge →
 * ff-only dirty-safe worktree advance (G-7c/G-7b). No swarm.
 *
 * Acceptance pinned here (lane C brief): a ff-advance updates the worktree; a
 * divergent one is refused + surfaced (accepted at the MIRROR level — the
 * watermark still moves — but the worktree stays put); junk envelopes are
 * rejected BEFORE any fetch.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/worktree-bridge.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, readNamespaceRef, writeNamespaceRef } from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF } from './integrator';
import { type EpochSeq, type SignedStagingAdvance, signStagingAdvance } from './staging-advance';
import {
  type WorktreeBridgeConfig,
  bridgeStagingShaToWorktree,
  handleStagingAdvance,
} from './worktree-bridge';

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

describe('worktree-bridge (G-7: announcement → fetch → accept → ff worktree advance)', () => {
  let root: string;
  let src: string; // scratch worktree that mints real-content staging commits
  let peerRepo: string; // the integrator machine's bare mirror (serves upload-pack)
  let localMirror: string; // THIS machine's bare mirror
  let wt: string; // this machine's working tree
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

  /** Publish `sha` (already minted in src) into the peer's integrator namespace. */
  async function publishToPeer(sha: string, expectedOld?: string): Promise<void> {
    await git(['fetch', '-q', src, `+refs/heads/main:refs/bridge-src`], peerRepo);
    await writeNamespaceRef(peerRepo, integrator.pubkeyBase64, STAGING_REF, sha, defaultRunGit, expectedOld);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgbridge-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    // Mint staging commits with real file content in a scratch worktree.
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

    peerRepo = await ensurePotGitRepo('hive-b', 'repo-int');
    localMirror = await ensurePotGitRepo('hive-b', 'repo-local');
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

  function cfg(prior: { epochSeq: EpochSeq | null; stagingSha: string | null }): WorktreeBridgeConfig {
    return {
      bareRepoPath: localMirror,
      worktreePath: wt,
      prior,
      openDuplex,
      accept: { expectedDevice: integrator.pubkeyBase64 },
    };
  }

  let watermark: { epochSeq: EpochSeq | null; stagingSha: string | null } = {
    epochSeq: null,
    stagingSha: null,
  };

  it('first announcement seeds an unborn worktree (fetch → accept → advance)', async () => {
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 1, s1));
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.watermark).toEqual({ epochSeq: { epoch: 1, seq: 1 }, stagingSha: s1 });
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    expect(res.advance.from).toBeNull();
    watermark = res.watermark;
    // The worktree followed; the mirror holds the integrator's namespace.
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s1);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(await readNamespaceRef(localMirror, integrator.pubkeyBase64, STAGING_REF)).toBe(s1);
  });

  it('a later announcement ff-advances the worktree', async () => {
    await publishToPeer(s2, s1);
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 2, s2));
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    watermark = res.watermark;
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s2);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('a replayed / stale announcement is rejected BEFORE any fetch', async () => {
    const dialsBefore = dials;
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 2, s2));
    expect(res).toEqual({ outcome: 'rejected', reason: 'stale-epoch-seq', preFetch: true });
    expect(dials).toBe(dialsBefore); // the pure fence never dialed out
  });

  it('a forged announcement is rejected BEFORE any fetch', async () => {
    const dialsBefore = dials;
    const forger = keypair();
    // Forger with its OWN device fails the device gate…
    const own = await signStagingAdvance(
      { devicePubkeyBase64: forger.pubkeyBase64, epoch: 9, seq: 9, stagingSha: s2, nowMs: 1 },
      forger.sign,
    );
    const r1 = await handleStagingAdvance(cfg(watermark), own);
    expect(r1).toEqual({ outcome: 'rejected', reason: 'wrong-device', preFetch: true });
    // …and forging the INTEGRATOR's identity fails the signature.
    const impersonated = await signStagingAdvance(
      { devicePubkeyBase64: integrator.pubkeyBase64, epoch: 9, seq: 9, stagingSha: s2, nowMs: 1 },
      forger.sign,
    );
    const r2 = await handleStagingAdvance(cfg(watermark), impersonated);
    expect(r2).toEqual({ outcome: 'rejected', reason: 'bad-signature', preFetch: true });
    expect(dials).toBe(dialsBefore);
  });

  it('a divergent worktree is surfaced (manual), while the MIRROR still accepts the advance', async () => {
    // The local machine commits its own work on top of s2 → the worktree head
    // is no longer an ancestor of the next staging.
    await writeFile(join(wt, 'local.txt'), 'local work\n');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'local L'], wt);
    const localHead = await git(['rev-parse', 'HEAD'], wt);

    // Integrator publishes s3 (child of s2, sibling of the local commit).
    await writeFile(join(src, 'f.txt'), 'v3\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S3'], src);
    s3 = await git(['rev-parse', 'HEAD'], src);
    await publishToPeer(s3, s2);

    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 3, s3));
    expect(res.outcome).toBe('accepted'); // staging itself moved: watermark advances
    if (res.outcome !== 'accepted') return;
    expect(res.watermark.stagingSha).toBe(s3);
    expect(res.advance.outcome).toBe('diverged-manual'); // surfaced, not clobbered
    watermark = res.watermark;
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(localHead); // untouched
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('REGRESSION (HIGH): a gate-less config THROWS — the watermark-poisoning DoS is unreachable', async () => {
    // The attack: any key self-signs an epoch-1e9 envelope over the CURRENT
    // sha. With no device gate, acceptStagingAdvance checks signature
    // SELF-consistency only — the fence would accept it, the caller would
    // persist the poisoned watermark, and every real advance thereafter would
    // be stale-epoch-seq. The bridge now refuses to run without a device gate.
    const attacker = keypair();
    const poison = await signStagingAdvance(
      { devicePubkeyBase64: attacker.pubkeyBase64, epoch: 1e9, seq: 1, stagingSha: s3, nowMs: 1 },
      attacker.sign,
    );
    const dialsBefore = dials;
    const gateless = { ...cfg(watermark), accept: {} };
    await expect(handleStagingAdvance(gateless, poison)).rejects.toThrow(/device gate/);
    const missing = { ...cfg(watermark) } as { accept?: unknown };
    delete missing.accept;
    await expect(
      handleStagingAdvance(missing as unknown as WorktreeBridgeConfig, poison),
    ).rejects.toThrow(/device gate/);
    expect(dials).toBe(dialsBefore); // it never even dialed out

    // And WITH the gate, the same poison envelope is rejected pre-fetch.
    const gated = await handleStagingAdvance(cfg(watermark), poison);
    expect(gated).toEqual({ outcome: 'rejected', reason: 'wrong-device', preFetch: true });
    expect(dials).toBe(dialsBefore);
  });

  it('a dead transport is fetch-failed (retry next announce), never a throw', async () => {
    const res = await handleStagingAdvance(
      {
        ...cfg(watermark),
        openDuplex: () => Promise.reject(new Error('swarm unreachable')),
      },
      await announce(1, 4, s3),
    );
    expect(res.outcome).toBe('fetch-failed');
  });

  it('without openDuplex the bridge serves from the local mirror (integrator-machine path)', async () => {
    // A SECOND machine-view: fresh worktree following the SAME local mirror
    // (which already holds s3 from the earlier fetch), no transport at all.
    const wt2 = join(root, 'wt2');
    await initWorktree(wt2);
    const res = await handleStagingAdvance(
      {
        bareRepoPath: localMirror,
        worktreePath: wt2,
        prior: { epochSeq: null, stagingSha: null },
        accept: { expectedDevice: integrator.pubkeyBase64 },
      },
      await announce(1, 3, s3),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    expect(await readFile(join(wt2, 'f.txt'), 'utf8')).toBe('v3\n');
  });

  it('a deferred-dirty advance is retried by the sweep via bridgeStagingShaToWorktree', async () => {
    const wt3 = join(root, 'wt3');
    await initWorktree(wt3);
    await writeFile(join(wt3, 'f.txt'), 'in the way\n'); // untracked, in the target tree
    const res = await handleStagingAdvance(
      {
        bareRepoPath: localMirror,
        worktreePath: wt3,
        prior: { epochSeq: null, stagingSha: null },
        accept: { expectedDevice: integrator.pubkeyBase64 },
      },
      await announce(1, 3, s3),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome).toBe('deferred-dirty'); // watermark persisted anyway
    expect(await readFile(join(wt3, 'f.txt'), 'utf8')).toBe('in the way\n');

    // The dirt drains (autocommit / user removes it) → the sweep retries with
    // the persisted watermark sha and catches the worktree up.
    await rm(join(wt3, 'f.txt'));
    const retried = await bridgeStagingShaToWorktree(localMirror, wt3, integrator.pubkeyBase64, s3);
    expect(retried.outcome, retried.detail).toBe('advanced');
    expect(await readFile(join(wt3, 'f.txt'), 'utf8')).toBe('v3\n');
  });
});
