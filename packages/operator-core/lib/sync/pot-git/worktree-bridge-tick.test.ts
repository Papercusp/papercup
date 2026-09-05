/**
 * worktree-bridge-tick.test.ts — the BATCH POLICY of `runWorktreeBridgeTick`
 * (WI-2039873 / P-203 Leg A: a fetch failure must not head-of-line block the
 * batch), tested through the `handle` seam with scripted per-announcement
 * outcomes. Everything git/socket/signature-shaped lives in
 * worktree-bridge-tick.integration.test.ts; this file owns only the
 * continue / hold / supersede / stop decision and the cursor index it reports.
 */
import { describe, expect, it } from 'vitest';
import type { Duplex } from 'node:stream';
import type { SignedStagingAdvance } from './staging-advance';
import type { StagingAdvanceBridgeResult, WorktreeBridgeConfig } from './worktree-bridge';
import { runWorktreeBridgeTick } from './worktree-bridge-tick';

const DEV_A = 'A'.repeat(43) + '=';
const DEV_B = 'B'.repeat(43) + '=';

function advance(epoch: number, seq: number, device = DEV_A): SignedStagingAdvance {
  return {
    v: 1,
    epoch,
    seq,
    device_pubkey: device,
    staging_sha: `${seq}`.padStart(2, '0').repeat(20),
    ts: 1_000 + seq,
    sig: 'c2ln',
  };
}

const accepted = (a: SignedStagingAdvance): StagingAdvanceBridgeResult => ({
  outcome: 'accepted',
  watermark: { epochSeq: { epoch: a.epoch, seq: a.seq }, stagingSha: a.staging_sha },
  advance: { outcome: 'advanced', from: null, to: a.staging_sha },
});
const fetchFailed: StagingAdvanceBridgeResult = { outcome: 'fetch-failed', detail: 'no live dial path' };
const inFlight: StagingAdvanceBridgeResult = { outcome: 'already-in-flight' };
const rejected = (reason: 'unknown-sha' | 'non-fast-forward' | 'stale-epoch-seq'): StagingAdvanceBridgeResult => ({
  outcome: 'rejected',
  reason,
  preFetch: true,
});

type Script = Record<number, StagingAdvanceBridgeResult | 'accept'>;

/** Script outcomes by seq; `'accept'` builds the accepted result from the announcement. */
function scripted(script: Script) {
  const seen: number[] = [];
  const handle = async (_cfg: WorktreeBridgeConfig, incoming: SignedStagingAdvance) => {
    seen.push(incoming.seq);
    const out = script[incoming.seq];
    if (out === undefined) throw new Error(`unscripted seq ${incoming.seq}`);
    return out === 'accept' ? accepted(incoming) : out;
  };
  return { handle, seen };
}

function run(pending: SignedStagingAdvance[], script: Script, extra: Partial<Parameters<typeof runWorktreeBridgeTick>[0]> = {}) {
  const { handle, seen } = scripted(script);
  return runWorktreeBridgeTick({
    bareRepoPath: '/nonexistent/bare',
    worktreePath: '/nonexistent/wt',
    pending,
    prior: { epochSeq: null, stagingSha: null },
    accept: { allowLegacy: true, allowedDevices: [DEV_A, DEV_B] },
    handle,
    ...extra,
  }).then((out) => ({ out, seen }));
}

describe('runWorktreeBridgeTick — a fetch failure does not head-of-line block the batch (WI-2039873)', () => {
  it('continues past a fetch failure; a later accept SUPERSEDES it and the cursor consumes both', async () => {
    const { out, seen } = await run([advance(1, 1), advance(1, 2)], { 1: fetchFailed, 2: 'accept' });
    expect(seen).toEqual([1, 2]); // the second item was ATTEMPTED this tick
    expect(out.results.map((r) => r.bridge.outcome)).toEqual(['fetch-failed', 'accepted']);
    expect(out.acceptedCount).toBe(1);
    expect(out.watermark.epochSeq).toEqual({ epoch: 1, seq: 2 });
    expect(out.stoppedOnFetchFailure).toBe(false); // superseded, not holding
    expect(out.unprocessedFromIndex).toBeNull(); // cursor consumes the whole batch
    expect(out.errors.some((e) => e.includes('superseded by a later accepted advance'))).toBe(true);
  });

  it('holds the cursor at the FIRST un-superseded fetch failure when nothing later is accepted', async () => {
    const { out, seen } = await run([advance(1, 1), advance(1, 2, DEV_B)], { 1: fetchFailed, 2: fetchFailed });
    expect(seen).toEqual([1, 2]);
    expect(out.stoppedOnFetchFailure).toBe(true);
    expect(out.unprocessedFromIndex).toBe(0);
    expect(out.watermark.epochSeq).toBeNull();
  });

  it('holds at a later un-superseded failure while an earlier one was overtaken', async () => {
    // [fail seq1, accept seq2, fail seq3]: seq1 is superseded by seq2; seq3 is
    // past the watermark, so it is the one the cursor must hold for.
    const { out } = await run([advance(1, 1), advance(1, 2), advance(1, 3, DEV_B)], {
      1: fetchFailed,
      2: 'accept',
      3: fetchFailed,
    });
    expect(out.acceptedCount).toBe(1);
    expect(out.stoppedOnFetchFailure).toBe(true);
    expect(out.unprocessedFromIndex).toBe(2);
  });

  it('supersession is by (epoch, seq), not by batch position — an out-of-order later fence is still held', async () => {
    // The failed item carries a HIGHER fence than the accepted one that follows
    // it in the log, so on retry it would NOT reject as stale: hold it.
    const { out } = await run([advance(1, 5), advance(1, 4)], { 5: fetchFailed, 4: 'accept' });
    expect(out.watermark.epochSeq).toEqual({ epoch: 1, seq: 4 });
    expect(out.stoppedOnFetchFailure).toBe(true);
    expect(out.unprocessedFromIndex).toBe(0);
  });

  it('terminal rejections after a fetch failure still skip-and-continue and are counted', async () => {
    const { out, seen } = await run([advance(1, 1), advance(1, 2), advance(1, 3), advance(1, 4)], {
      1: 'accept',
      2: fetchFailed,
      3: rejected('non-fast-forward'),
      4: fetchFailed,
    });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(out.terminalRejections).toEqual({ 'non-fast-forward': 1 });
    expect(out.results).toHaveLength(4);
    expect(out.unprocessedFromIndex).toBe(1); // the earliest held failure
  });

  it('a RETRYABLE rejection still stops the batch, and the hold is the EARLIER of it and an un-superseded failure', async () => {
    const { out, seen } = await run([advance(1, 1), advance(1, 2), advance(1, 3)], {
      1: fetchFailed,
      2: rejected('unknown-sha'),
      3: 'accept',
    });
    expect(seen).toEqual([1, 2]); // stopped at the retryable rejection; seq 3 not attempted
    expect(out.stoppedOnFetchFailure).toBe(true);
    expect(out.unprocessedFromIndex).toBe(0);
    expect(out.errors.some((e) => e.includes('retryable rejection'))).toBe(true);
  });

  it('a retryable stop AFTER an accept that superseded the failure holds at the stop itself', async () => {
    const { out } = await run([advance(1, 1), advance(1, 2), advance(1, 3)], {
      1: fetchFailed,
      2: 'accept',
      3: rejected('unknown-sha'),
    });
    expect(out.stoppedOnFetchFailure).toBe(false);
    expect(out.unprocessedFromIndex).toBe(2);
  });

  it('already-in-flight stops the batch without an error, holding at the earlier un-superseded failure', async () => {
    const { out, seen } = await run([advance(1, 1), advance(1, 2), advance(1, 3)], {
      1: 'accept',
      2: fetchFailed,
      3: inFlight,
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(out.unprocessedFromIndex).toBe(1);
    expect(out.errors.filter((e) => !e.startsWith('fetch failed'))).toEqual([]);
  });

  it('does not re-dial a device whose fetch already failed this tick, but still dials other devices', async () => {
    const dialed: string[] = [];
    const openDuplex = async (device: string): Promise<Duplex> => {
      dialed.push(device);
      throw new Error('swarm unreachable');
    };
    // A handler that needs the dial for every item, exactly like a cold mirror.
    const handle = async (cfg: WorktreeBridgeConfig, incoming: SignedStagingAdvance): Promise<StagingAdvanceBridgeResult> => {
      try {
        await cfg.openDuplex!(incoming.device_pubkey);
        return accepted(incoming);
      } catch (e) {
        return { outcome: 'fetch-failed', detail: e instanceof Error ? e.message : String(e) };
      }
    };
    const out = await runWorktreeBridgeTick({
      bareRepoPath: '/nonexistent/bare',
      worktreePath: '/nonexistent/wt',
      pending: [advance(1, 1, DEV_A), advance(1, 2, DEV_A), advance(1, 3, DEV_B), advance(1, 4, DEV_A)],
      prior: { epochSeq: null, stagingSha: null },
      accept: { allowLegacy: true, allowedDevices: [DEV_A, DEV_B] },
      openDuplex,
      handle,
    });
    // Every item was attempted (results 4), but the upstream dial fired once per device.
    expect(out.results).toHaveLength(4);
    expect(dialed).toEqual([DEV_A, DEV_B]);
    expect(out.results[1]!.bridge).toMatchObject({ outcome: 'fetch-failed', detail: expect.stringContaining('dial skipped') });
    expect(out.results[3]!.bridge).toMatchObject({ outcome: 'fetch-failed', detail: expect.stringContaining('dial skipped') });
    expect(out.unprocessedFromIndex).toBe(0);
  });

  it('an empty batch stays a fast no-op with the unchanged contract', async () => {
    const { out, seen } = await run([], {});
    expect(seen).toEqual([]);
    expect(out).toMatchObject({ ran: false, stoppedOnFetchFailure: false, unprocessedFromIndex: null, errors: [] });
  });
});
