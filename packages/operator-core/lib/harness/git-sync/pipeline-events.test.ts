/**
 * pipeline-events.test.ts — pure unit coverage for the window-fold logic (mig 177) and
 * the EI-18676650746298156 candidate-prefix matcher. The append/summarize/recent/
 * findGreenCheckpointVerdictForCandidate DB round-trip is covered in
 * pipeline-events.integration.test.ts (real Postgres).
 */
import { describe, expect, it } from 'vitest';
import { foldPipelineWindow, emptyWindow, candidatePrefixMatches } from './pipeline-events';

describe('foldPipelineWindow', () => {
  it('folds (kind,status,count) rows into the typed per-kind summary', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: 100 },
        { kind: 'git_sync', status: 'nothing', n: 40 },
        { kind: 'git_sync', status: 'conflict', n: 3 },
        { kind: 'git_sync', status: 'error', n: 1 },
        { kind: 'merge_resolver', status: 'ok', n: 2 },
        { kind: 'merge_resolver', status: 'failed', n: 1 },
        { kind: 'green_checkpoint', status: 'advanced', n: 5 },
        { kind: 'green_checkpoint', status: 'up-to-date', n: 18 },
        { kind: 'green_checkpoint', status: 'not-green', n: 2 },
      ],
      1000,
    );
    expect(w.sinceMs).toBe(1000);
    expect(w.gitSync).toEqual({ total: 144, synced: 100, nothing: 40, conflict: 3, error: 1 });
    expect(w.mergeResolver).toEqual({ total: 3, ok: 2, failed: 1, error: 0 });
    expect(w.greenCheckpoint).toMatchObject({ total: 25, advanced: 5, upToDate: 18, notGreen: 2 });
  });

  it('counts unknown statuses toward the kind total but not a named bucket', () => {
    const w = foldPipelineWindow([{ kind: 'git_sync', status: 'weird-future-status', n: 7 }], 0);
    expect(w.gitSync.total).toBe(7);
    expect(w.gitSync.synced + w.gitSync.nothing + w.gitSync.conflict + w.gitSync.error).toBe(0);
  });

  it('coerces string counts (postgres count(*) can arrive as text) and ignores unknown kinds', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'git_sync', status: 'synced', n: '12' },
        { kind: 'totally-unknown-kind', status: 'ok', n: 9 }, // ignored entirely
      ],
      0,
    );
    expect(w.gitSync.synced).toBe(12);
    expect(w.gitSync.total).toBe(12);
    expect(w.deploy.total).toBe(0);
  });

  it('folds auto-serve deploy attempts (ok / rolled-back / failed / refused)', () => {
    const w = foldPipelineWindow(
      [
        { kind: 'deploy', status: 'ok', n: 5 },
        { kind: 'deploy', status: 'rolled-back', n: 1 },
        { kind: 'deploy', status: 'failed', n: 1 },
        { kind: 'deploy', status: 'refused', n: 2 },
      ],
      0,
    );
    expect(w.deploy).toEqual({ total: 9, ok: 5, rolledBack: 1, failed: 1, refused: 2 });
  });

  it('emptyWindow is all zeros', () => {
    const w = emptyWindow(42);
    expect(w.sinceMs).toBe(42);
    expect(w.gitSync.total).toBe(0);
    expect(w.mergeResolver.total).toBe(0);
    expect(w.greenCheckpoint.total).toBe(0);
  });
});

// EI-18676650746298156: checkpoint:await's candidateSha already-judged latch matches on
// this function alone — buildCheckpointDetail truncates the WRITTEN `detail.candidate` to
// 12 chars, and a caller's candidateSha can be anywhere from 4 to 64 chars, so the matcher
// must work correctly regardless of which side is shorter.
describe('candidatePrefixMatches — prefix-safe candidate-sha comparison', () => {
  it('matches a full 40-char sha against its own 12-char stored (truncated) prefix', () => {
    const full = '94c1234567890abcdef1234567890abcdef12345';
    const stored = full.slice(0, 12);
    expect(candidatePrefixMatches(full, stored)).toBe(true);
  });

  it('matches a short caller-supplied prefix (4 chars, the arg floor) against a longer stored value', () => {
    expect(candidatePrefixMatches('94c1', '94c1234567')).toBe(true);
  });

  it('matches two equal-length values', () => {
    expect(candidatePrefixMatches('94c1234567', '94c1234567')).toBe(true);
  });

  it('rejects genuinely different candidates even when both are 12 chars', () => {
    expect(candidatePrefixMatches('94c1234567ab', 'ffffffffffff')).toBe(false);
  });

  it('rejects a same-length near-miss (differs only in the last char)', () => {
    expect(candidatePrefixMatches('94c1234567ab', '94c1234567ac')).toBe(false);
  });

  it('WI-5685 shape: a DIFFERENT (later) candidate that happens to share a short prefix is not conflated once the overlap is long enough to disambiguate', () => {
    // Two distinct real commits that happen to share their first 4 hex chars but diverge
    // after that — the exact scenario the 4-char floor exists to still get right once the
    // compared prefix is long enough to tell them apart.
    expect(candidatePrefixMatches('94c1aaaaaaaa', '94c1bbbbbbbb')).toBe(false);
  });

  it('refuses to match below the 4-char floor — never risk a false positive on a coincidental short overlap', () => {
    expect(candidatePrefixMatches('94c', '94c')).toBe(false);
    expect(candidatePrefixMatches('9', '9')).toBe(false);
  });

  it('rejects empty/missing values on either side', () => {
    expect(candidatePrefixMatches('', 'anything')).toBe(false);
    expect(candidatePrefixMatches('anything', '')).toBe(false);
    expect(candidatePrefixMatches('', '')).toBe(false);
  });
});
