/**
 * worktree-bridge-tick.integration.test.ts — P-204 driver: a BATCH of pending
 * staging-advance announcements processed in order, threading the running
 * watermark, with the continue-on-reject / stop-on-fetch-failure batch
 * contract (see worktree-bridge-tick.ts's module header).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/worktree-bridge-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef } from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF } from './integrator';
import { type EpochSeq, type SignedStagingAdvance, signStagingAdvance } from './staging-advance';
import {
  decideWorktreeBridgeCursor,
  runWorktreeBridgeTick,
  WORKTREE_BRIDGE_RETRY_TTL_MS,
} from './worktree-bridge-tick';

describe('P-505 retryable fed-event cursor policy', () => {
  const nowMs = 100_000_000;
  const rows = [
    { id: 41, tsMs: nowMs - 1_000 },
    { id: 42, tsMs: nowMs - WORKTREE_BRIDGE_RETRY_TTL_MS },
    { id: 43, tsMs: nowMs - WORKTREE_BRIDGE_RETRY_TTL_MS - 1 },
    { id: 44, tsMs: nowMs - WORKTREE_BRIDGE_RETRY_TTL_MS - 2 },
  ];

  it('consumes the full collected range when the tick durably processed every row', () => {
    expect(
      decideWorktreeBridgeCursor({
        maxRowId: 44,
        pendingRows: rows,
        unprocessedFromIndex: null,
        nowMs,
      }),
    ).toEqual({ cursor: 44, expiredRow: null });
  });

  it('holds immediately before a retryable row through the exact TTL boundary', () => {
    expect(
      decideWorktreeBridgeCursor({
        maxRowId: 44,
        pendingRows: rows,
        unprocessedFromIndex: 1,
        nowMs,
      }),
    ).toEqual({ cursor: 41, expiredRow: null });
  });

  it('consumes only an expired stopped row and keeps its later tail pending', () => {
    expect(
      decideWorktreeBridgeCursor({
        maxRowId: 44,
        pendingRows: rows,
        unprocessedFromIndex: 2,
        nowMs,
      }),
    ).toEqual({ cursor: 43, expiredRow: rows[2] });
  });

  it('holds indefinitely when the stopped row has no trustworthy timestamp', () => {
    expect(
      decideWorktreeBridgeCursor({
        maxRowId: 45,
        pendingRows: [{ id: 45, tsMs: null }],
        unprocessedFromIndex: 0,
        nowMs,
      }),
    ).toEqual({ cursor: 44, expiredRow: null });
  });

  it.each([-1, rows.length, 1.5, Number.NaN])(
    'fails closed instead of consuming an unprocessed row for invalid stop index %s',
    (unprocessedFromIndex) => {
      expect(() =>
        decideWorktreeBridgeCursor({
          maxRowId: 44,
          pendingRows: rows,
          unprocessedFromIndex,
          nowMs,
        }),
      ).toThrow(RangeError);
    },
  );
});

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
  /** EI-19332963201820362: a commit strictly AHEAD of s3, so the accept-census
   *  negative control has something that can genuinely fast-forward (every
   *  earlier sha is at-or-behind canonical by the time that test runs). */
  let s4 = '';

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
    await writeFile(join(src, 'f.txt'), 'v4\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S4'], src);
    s4 = await git(['rev-parse', 'HEAD'], src);

    peerRepo = await ensurePotGitRepo('hive-c', 'repo-int');
    localMirror = await ensurePotGitRepo('hive-c', 'repo-local');
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
    expect(out).toEqual({
      ran: false,
      results: [],
      watermark: prior,
      stoppedOnFetchFailure: false,
      unprocessedFromIndex: null,
      errors: [],
      acceptedCount: 0,
      terminalRejections: {},
    });
    // EI-19332963201820362: an empty batch consumed NOTHING, so it must NOT
    // read as the accept-free fault. `consumed === 0` (results empty) is the
    // discriminator between a healthy idle bridge and a starving one; without
    // it, "accepted 0" alone would fire on every quiet tick.
    expect(out.results).toHaveLength(0);
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
    // Two more (never-published) advances the dead transport would need to
    // fetch. EI-14555: these MUST name shas absent from the local mirror —
    // the fetch is now on-demand, so an advance reusing an already-local sha
    // (s3, as this test previously did) never reaches the transport at all.
    const a4 = await announce(1, 4, 'f4'.repeat(20));
    const a5 = await announce(1, 5, 'f5'.repeat(20));
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
    expect(out.unprocessedFromIndex).toBe(0); // caller's cursor holds at the stopped item
    expect(out.results).toHaveLength(1); // stopped after the first fetch-failed item
    expect(out.results[0].bridge.outcome).toBe('fetch-failed');
    expect(out.errors.length).toBeGreaterThan(0);
    // Watermark unchanged — nothing was accepted this tick.
    expect(out.watermark).toEqual(priorWatermark);
    expect(dials).toBe(dialsBefore); // deadOpenDuplex never actually connects
  });

  it('a RETRYABLE rejection (unknown-sha) STOPS the batch and reports the hold index (P-505)', async () => {
    // A signed advance for objects that never federated — with no dial seam the
    // sha cannot resolve locally, which must HOLD the cursor (the objects
    // arrive with a later ref-announce fetch), never drop the advance forever.
    const ghost = await announce(1, 4, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const alsoPending = await announce(1, 5, s3);
    const priorWatermark = { epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [ghost, alsoPending],
      prior: priorWatermark,
      accept: { expectedDevice: integrator.pubkeyBase64 },
      // no openDuplex — the unknown sha rejects pre-fetch
    });
    expect(out.ran).toBe(true);
    expect(out.stoppedOnFetchFailure).toBe(false);
    expect(out.unprocessedFromIndex).toBe(0); // held AT the ghost — tail untouched
    expect(out.results).toHaveLength(1);
    expect(out.results[0].bridge).toMatchObject({ outcome: 'rejected', reason: 'unknown-sha' });
    expect(out.watermark).toEqual(priorWatermark);
    expect(out.errors.some((e) => e.includes('retryable rejection'))).toBe(true);
  });

  it('a RETRYABLE rejection (ungranted-epoch) STOPS the batch — a successor authority whose token has not federated yet is held, not dropped (P-505)', async () => {
    // Epoch 5 exceeds the receiver's provable grant cap — the granting handoff
    // token simply has not federated yet, so the advance must retry later.
    const successor = await announce(5, 1, s3);
    const priorWatermark = { epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [successor],
      prior: priorWatermark,
      accept: { expectedDevice: integrator.pubkeyBase64, maxGrantedEpoch: 1 },
    });
    expect(out.ran).toBe(true);
    expect(out.unprocessedFromIndex).toBe(0);
    expect(out.results[0].bridge).toMatchObject({ outcome: 'rejected', reason: 'ungranted-epoch' });
    expect(out.watermark).toEqual(priorWatermark);
  });

  it('a TERMINAL rejection (stale-epoch-seq) still skips-and-continues — never holds the cursor', async () => {
    const stale = await announce(1, 1, s1); // long-superseded (epoch, seq)
    const priorWatermark = { epochSeq: { epoch: 1, seq: 3 }, stagingSha: s3 };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [stale],
      prior: priorWatermark,
      accept: { expectedDevice: integrator.pubkeyBase64 },
    });
    expect(out.ran).toBe(true);
    expect(out.unprocessedFromIndex).toBe(null); // fully processed — cursor consumes it
    expect(out.results[0].bridge).toMatchObject({ outcome: 'rejected', reason: 'stale-epoch-seq' });
    expect(out.watermark).toEqual(priorWatermark);
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

  it('a watermark whose OBJECT is missing re-anchors on the bare canonical ref instead of rejecting forever', async () => {
    // Regression (hello-world-3-pot canary, 2026-07-18): the persisted
    // stagingSha pointed at an object absent from the local store (drill
    // residue), so merge-base --is-ancestor errored and EVERY legitimate
    // advance — including the epoch-2 authority-takeover announcement — was
    // consumed + rejected as non-fast-forward, wedging acceptance forever.
    const bogus = '1111111111111111111111111111111111111111';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // canonical currently sits at s3 from the earlier accepted batch; the
      // incoming advance re-publishes s3 under a fresh (epoch, seq).
      const out = await runWorktreeBridgeTick({
        bareRepoPath: localMirror,
        worktreePath: wt,
        pending: [await announce(2, 1, s3)],
        prior: { epochSeq: { epoch: 1, seq: 3 }, stagingSha: bogus },
        accept: { expectedDevice: integrator.pubkeyBase64, maxGrantedEpoch: 2 },
        openDuplex,
      });
      expect(out.ran).toBe(true);
      expect(out.results[0].bridge.outcome).toBe('accepted');
      expect(out.watermark).toEqual({ epochSeq: { epoch: 2, seq: 1 }, stagingSha: s3 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-anchoring the FF fence'));
    } finally {
      warn.mockRestore();
    }
  });

  it('the re-anchored fence still REJECTS a genuine rewind (missing watermark is no bypass)', async () => {
    const bogus = '1111111111111111111111111111111111111111';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // canonical is at s3; an announcement rewinding to s1 must still reject
      // non-fast-forward even though the recorded watermark is unverifiable.
      const out = await runWorktreeBridgeTick({
        bareRepoPath: localMirror,
        worktreePath: wt,
        pending: [await announce(2, 2, s1)],
        prior: { epochSeq: { epoch: 2, seq: 1 }, stagingSha: bogus },
        accept: { expectedDevice: integrator.pubkeyBase64, maxGrantedEpoch: 2 },
        openDuplex,
      });
      expect(out.ran).toBe(true);
      expect(out.results[0].bridge).toEqual({ outcome: 'rejected', reason: 'non-fast-forward', preFetch: false });
      // EI-19332963201820362: the rejection is now COUNTED, not merely skipped.
      expect(out.acceptedCount).toBe(0);
      expect(out.terminalRejections).toEqual({ 'non-fast-forward': 1 });
    } finally {
      warn.mockRestore();
    }
  });

  // EI-19332963201820362 — the regression guard for the 2026-08-02 freeze.
  //
  // For ~6h, canonical staging did not advance while the worktree accumulated
  // 85 commits with no off-box copy, and EVERY health surface read green:
  // last_status 'synced', last_error null, worktree_bridge.at advancing every
  // tick. The bridge was consuming announcements and terminally rejecting all
  // of them ('non-fast-forward', because our published namespace head trailed
  // the accepted watermark), and a terminal rejection skipped-and-continued
  // emitting NOTHING — no error, no counter, no log line.
  //
  // The defect was never in the SKIPPING (that is correct — one bad envelope
  // must not starve the batch). It was in the SILENCE. This asserts the tick
  // now makes "consumed N, accepted 0" observable, which is the single fact
  // that separates a starving bridge from a healthy idle one.
  it('EI-19332963201820362: a tick that consumes announcements and accepts NONE is observable in the outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Three rewinds to already-superseded shas — every one terminally
      // rejects non-fast-forward, exactly as in the incident.
      const priorWatermark = { epochSeq: { epoch: 2, seq: 2 }, stagingSha: s3 };
      const out = await runWorktreeBridgeTick({
        bareRepoPath: localMirror,
        worktreePath: wt,
        pending: [await announce(2, 3, s1), await announce(2, 4, s2), await announce(2, 5, s1)],
        prior: priorWatermark,
        accept: { expectedDevice: integrator.pubkeyBase64, maxGrantedEpoch: 2 },
        openDuplex,
      });

      // The pre-existing contract is UNCHANGED: skip-and-continue, cursor
      // consumes the whole batch, watermark stands still. Nothing here is a
      // new behaviour — the batch is processed exactly as before.
      expect(out.ran).toBe(true);
      expect(out.unprocessedFromIndex).toBe(null);
      expect(out.results).toHaveLength(3);
      expect(out.watermark).toEqual(priorWatermark);

      // What is NEW: the tick is no longer silent about it.
      expect(out.acceptedCount).toBe(0);
      expect(out.terminalRejections).toEqual({ 'non-fast-forward': 3 });

      // The detector's exact predicate — consumed >= 1 AND accepted 0. This is
      // the condition that was structurally unobservable before, and the whole
      // point of the change: `errors` stays EMPTY here (terminal rejections are
      // deliberately not errors), so a health layer watching `errors` alone
      // still sees nothing. The census is the only thing that can see it.
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.errors).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('EI-19332963201820362: a tick that accepts something reports a census that CLEARS the fault', async () => {
    // The negative control. A detector that cannot go back to green is a
    // detector that will be ignored — this pins the reset edge, which is what
    // the caller uses to zero its consecutive accept-free streak.
    await publishToPeer(s4, s3);
    const out = await runWorktreeBridgeTick({
      bareRepoPath: localMirror,
      worktreePath: wt,
      pending: [await announce(2, 6, s1), await announce(2, 7, s4)],
      prior: { epochSeq: { epoch: 2, seq: 2 }, stagingSha: s3 },
      accept: { expectedDevice: integrator.pubkeyBase64, maxGrantedEpoch: 2 },
      openDuplex,
    });
    expect(out.results).toHaveLength(2);
    expect(out.acceptedCount).toBe(1);
    expect(out.terminalRejections).toEqual({ 'non-fast-forward': 1 });
    // Mixed tick: something was accepted, so this is NOT the fault condition
    // even though a terminal rejection also occurred.
    expect(out.watermark).toEqual({ epochSeq: { epoch: 2, seq: 7 }, stagingSha: s4 });
  });
});
