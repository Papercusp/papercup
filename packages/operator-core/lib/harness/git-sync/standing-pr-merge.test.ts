import { describe, expect, it } from 'vitest';
import type { Pr } from '../../pr-host/types';
import type { MergeTestRecord } from './decide-merge-gate';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import {
  decideStandingPrMergePolicy,
  isStandingPr,
  stepStandingPrMerge,
  type AdvanceTargetResult,
  type StandingPrMergeDeps,
} from './standing-pr-merge';

const HEAD = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const TIP2 = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

function pr(over: Partial<Pr> = {}): Pr {
  return {
    ref: { number: 7 },
    head_ref: STANDING_PR_BRANCH,
    base_ref: 'main',
    head_sha: HEAD,
    review_decision: 'approved',
    checks_state: 'success',
    ...over,
  } as Pr;
}

function fakeDeps(opts: { tip?: string; last?: MergeTestRecord | null; merge?: string | null; advance?: AdvanceTargetResult } = {}) {
  const calls: { saved: MergeTestRecord[]; started: MergeTestRecord[]; advanced: Array<{ sha: string; expectedTip: string }> } = {
    saved: [],
    started: [],
    advanced: [],
  };
  const deps: StandingPrMergeDeps = {
    readTargetTip: async () => opts.tip ?? TIP,
    loadLastTest: async () => opts.last ?? null,
    saveTest: async (_n, rec) => void calls.saved.push(rec),
    buildMergeResult: async () => (opts.merge === undefined ? MERGE : opts.merge),
    startTests: async (_n, rec) => void calls.started.push(rec),
    advanceTarget: async (a) => {
      calls.advanced.push({ sha: a.sha, expectedTip: a.expectedTip });
      return opts.advance ?? { ok: true };
    },
  };
  return { deps, calls };
}

const review = { mode: 'review' as const, source: 'set' as const };

describe('decideStandingPrMergePolicy (P-021)', () => {
  it('defaults to the owner merging on GitHub', () => {
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: false, autoMergeEnabled: true }))
      .toEqual({ policy: 'owner', reason: 'upstream-not-managed' });
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: true, autoMergeEnabled: false }))
      .toEqual({ policy: 'owner', reason: 'auto-merge-off' });
    expect(
      decideStandingPrMergePolicy({
        integration: { mode: 'direct', source: 'absent' },
        upstreamPapercuspManaged: true,
        autoMergeEnabled: true,
      }),
    ).toEqual({ policy: 'owner', reason: 'not-review-mode' });
  });

  it('auto-merges only when <repo> is Papercusp-managed with auto-merge on', () => {
    expect(decideStandingPrMergePolicy({ integration: review, upstreamPapercuspManaged: true, autoMergeEnabled: true }))
      .toEqual({ policy: 'auto', reason: 'managed-auto-merge' });
  });

  it('recognises the standing PR by its head branch', () => {
    expect(isStandingPr({ head_ref: STANDING_PR_BRANCH })).toBe(true);
    expect(isStandingPr({ head_ref: 'feature/x' })).toBe(false);
  });
});

describe('stepStandingPrMerge (P-021 + P-024 exact-merge gate)', () => {
  const base = { policy: 'auto' as const, promotedSha: HEAD, authorRevoked: false };

  it('leaves the PR alone under the owner policy', async () => {
    const { deps, calls } = fakeDeps();
    expect(await stepStandingPrMerge({ ...base, pr: pr(), policy: 'owner' }, deps)).toEqual({ action: 'left-for-owner' });
    expect(calls.advanced).toEqual([]);
  });

  it('refuses a revoked author before any other gate', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr(), authorRevoked: true }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'author-revoked' });
    expect(calls.saved).toEqual([]);
  });

  it('applies the pr-host bar: approved and checks green', async () => {
    const { deps } = fakeDeps();
    expect(await stepStandingPrMerge({ ...base, pr: pr({ review_decision: 'changes_requested' }) }, deps))
      .toMatchObject({ action: 'skipped', reason: 'not-approved' });
    expect(await stepStandingPrMerge({ ...base, pr: pr({ checks_state: 'failure' } as Partial<Pr>) }, deps))
      .toMatchObject({ action: 'skipped', reason: 'checks-failing' });
  });

  it('builds the exact merge result and starts the suite on it when never tested', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(out).toMatchObject({ action: 'testing', reason: 'never-tested', mergeSha: MERGE });
    expect(calls.saved).toEqual([{ mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'running' }]);
    expect(calls.started.map((r) => r.mergeSha)).toEqual([MERGE]);
    expect(calls.advanced).toEqual([]);
  });

  it('refuses a PR whose head is not the promoted commit', async () => {
    const { deps, calls } = fakeDeps();
    const out = await stepStandingPrMerge({ ...base, pr: pr(), promotedSha: 'e'.repeat(40) }, deps);
    expect(out).toMatchObject({ action: 'refused', reason: 'pr-head-not-promoted' });
    expect(calls.saved).toEqual([]);
  });

  it('refuses a merge conflict without recording a test', async () => {
    const { deps, calls } = fakeDeps({ merge: null });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'refused', reason: 'merge-conflict' });
    expect(calls.started).toEqual([]);
  });

  it('waits while the suite runs on the merge result', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'running' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'waiting', mergeSha: MERGE });
    expect(calls.advanced).toEqual([]);
  });

  it('advances the target to exactly the tested sha under a lease on the tested tip', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'merged', mergeSha: MERGE });
    expect(calls.advanced).toEqual([{ sha: MERGE, expectedTip: TIP }]);
  });

  it('re-tests instead of merging when the target moved after the test', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps, calls } = fakeDeps({ last, tip: TIP2 });
    const out = await stepStandingPrMerge({ ...base, pr: pr() }, deps);
    expect(out).toMatchObject({ action: 'testing', reason: 'target-moved' });
    expect(calls.saved[0]).toMatchObject({ targetTipSha: TIP2, result: 'running' });
    expect(calls.advanced).toEqual([]);
  });

  it('reports target-moved when the target moves during the push itself', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'pass' as const };
    const { deps } = fakeDeps({ last, advance: { ok: false, tipAtPush: TIP2, error: 'non-fast-forward' } });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'retest', reason: 'target-moved' });
  });

  it('never merges a result whose suite failed', async () => {
    const last = { mergeSha: MERGE, prHeadSha: HEAD, targetTipSha: TIP, result: 'fail' as const };
    const { deps, calls } = fakeDeps({ last });
    expect(await stepStandingPrMerge({ ...base, pr: pr() }, deps)).toMatchObject({ action: 'refused', reason: 'merge-result-failed' });
    expect(calls.advanced).toEqual([]);
  });
});
