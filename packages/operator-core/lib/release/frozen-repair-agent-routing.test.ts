import { describe, expect, it } from 'vitest';
import {
  actionableConditionFor,
  isActionableConditionKey,
} from '../coord/actionable-conditions';
import {
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
  buildFrozenRepairConvergenceBroadcast,
  frozenRepairConvergenceConditionKey,
} from './frozen-repair-agent-routing';

const T0 = Date.parse('2026-09-02T16:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

const input = (
  over: Partial<Parameters<typeof buildFrozenRepairConvergenceBroadcast>[0]> = {},
): Parameters<typeof buildFrozenRepairConvergenceBroadcast>[0] => ({
  pipeline: 'papercusp',
  candidate: 'a'.repeat(40),
  repairHead: 'b'.repeat(40),
  failingTests: ['packages/operator-core/lib/one.test.ts'],
  capacityRetryAtMs: T0 + 6 * 24 * HOUR,
  capacitySummary: 'all codex accounts are usage-walled',
  heldMs: HOUR,
  convergenceHoldMs: 4 * HOUR,
  nowMs: T0,
  ...over,
});

describe('frozenRepairConvergenceConditionKey', () => {
  it('is one key per pipeline, under the shared family prefix', () => {
    expect(frozenRepairConvergenceConditionKey('papercusp')).toBe(
      `${FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX}papercusp`,
    );
    // Co-hosted pipelines must not share one convergence work-item.
    expect(frozenRepairConvergenceConditionKey('papercup')).not.toBe(
      frozenRepairConvergenceConditionKey('papercusp'),
    );
  });
});

describe('the key this module emits is OPTED IN to minting a work-item', () => {
  it('is recognized as actionable, or the whole routing is inert', () => {
    // The failure this guards is silent by construction: a condition key outside
    // ACTIONABLE_CONDITIONS broadcasts happily and mints NOTHING, which is
    // indistinguishable from a gate that never held a candidate. P-003 is only "done" if
    // this holds.
    const key = buildFrozenRepairConvergenceBroadcast(input()).conditionKey;
    expect(isActionableConditionKey(key)).toBe(true);
    expect(actionableConditionFor(key)).toMatchObject({
      // 'suffix' is load-bearing: the harness is derived from the text after the prefix, so
      // the key MUST end in the pipeline slug and nothing else. A verdict-shaped suffix
      // (the `single-primary:no-primary` trap) files the item under a harness nobody
      // queries, successfully and forever invisibly.
      harnessFrom: 'suffix',
      severity: 'critical',
    });
  });

  it('CONTROL: the same probe returns false for a near-miss key, so the check above means something', () => {
    // Without this, `isActionableConditionKey(...) === true` could be a probe that returns
    // true for everything. The near-miss is the realistic drift — a prefix renamed in the
    // emitter but not the catalog — so that is what the control uses.
    expect(isActionableConditionKey('frozen-repair-converge:papercusp')).toBe(
      false,
    );
    expect(actionableConditionFor('frozen-repair-converge:papercusp')).toBeNull();
  });

  it('puts the pipeline slug — and only that — after the prefix, as harnessFrom:suffix requires', () => {
    const key = frozenRepairConvergenceConditionKey('papercusp');
    expect(key.slice(FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX.length)).toBe(
      'papercusp',
    );
  });
});

describe('buildFrozenRepairConvergenceBroadcast', () => {
  it('returns the condition key WITH the message, so a caller cannot hand-type a near-miss', () => {
    // A near-miss key mints a SECOND work-item for the same held candidate, which is the
    // one failure this whole item exists to avoid — so the key is not the caller's to spell.
    const ev = buildFrozenRepairConvergenceBroadcast(input());
    expect(ev.conditionKey).toBe(frozenRepairConvergenceConditionKey('papercusp'));
  });

  it('names the three things a claimant would otherwise reconstruct by hand', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({
        failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
      }),
    );
    // 1. WHICH sha is frozen.
    expect(ev.body).toContain('a'.repeat(40));
    // 2. WHAT is failing on it.
    expect(ev.body).toContain('lib/a.test.ts');
    expect(ev.body).toContain('lib/b.test.ts');
    // 3. The EXACT call that admits a fix to it.
    expect(ev.body).toContain("release:repair-queue { op: 'admit'");
    // …and that there is NO repair worktree to go looking for (P-003 / D-010): the fix is
    // authored on the shared checkout and lands only through the admit door above.
    expect(ev.body).toContain('there is no repair worktree');
    expect(ev.body).not.toContain('/.papercusp/worktrees/');
  });

  it('warns against fixing AT TIP, which is the default behaviour it exists to correct', () => {
    // A fix at tip is not in the frozen candidate, so the gate re-reds on the same file and
    // the fix reads as not having worked. That misreading is the expensive part.
    const ev = buildFrozenRepairConvergenceBroadcast(input());
    expect(ev.body).toContain('NOT AT TIP');
  });

  it('reports the remaining hold budget, not just the elapsed time', () => {
    // "3h before the candidate is retired" is the actionable half; "held for 1h" alone
    // leaves a claimant to subtract against a constant they do not have.
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ heldMs: HOUR, convergenceHoldMs: 4 * HOUR }),
    );
    expect(ev.summary).toContain('3h');
    expect(ev.body).toContain('1h of 4h');
    expect(ev.body).toContain('3h before the hold gives up');
  });

  it('never renders a negative remainder once the budget is spent', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ heldMs: 9 * HOUR, convergenceHoldMs: 4 * HOUR }),
    );
    // Scoped to the DURATION slots on purpose: a bare /-\d/ over the whole body matches the
    // ISO reset timestamp's own `-09-`, so it would pass for the wrong reason.
    expect(ev.body).not.toMatch(/-\d+(m|h)/);
    expect(ev.summary).not.toMatch(/-\d+(m|h)/);
    expect(ev.body).toContain('9h of 4h');
    expect(ev.body).toContain('0m before the hold gives up');
  });

  it('renders the wall reset when the probe measured one', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(input());
    expect(ev.body).toContain('2026-09-08T16:00:00.000Z');
    expect(ev.body).toContain('all codex accounts are usage-walled');
  });

  it('says so PLAINLY when the probe reported no reset time, rather than implying one', () => {
    // An unknown reset must not be rendered as a date; a claimant reading a fabricated
    // "lifts at" would size their own effort against it.
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ capacityRetryAtMs: null, capacitySummary: null }),
    );
    expect(ev.body).toContain('The probe reported no reset time.');
    expect(ev.body).toContain('no dispatchable capacity');
    expect(ev.body).not.toContain('lifts at');
  });

  it('bounds the named failing set instead of pasting an unbounded list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `lib/f${i}.test.ts`);
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ failingTests: many }),
    );
    expect(ev.body).toContain('lib/f0.test.ts');
    expect(ev.body).toContain('lib/f11.test.ts');
    expect(ev.body).not.toContain('lib/f12.test.ts');
    expect(ev.body).toContain('+18 more');
    // The COUNT stays honest even though the list is bounded — a truncated list read as a
    // total is how a 30-file red gets sized as a 12-file one.
    expect(ev.body).toContain('FAILING ON THE FROZEN CANDIDATE (30)');
  });

  it('says the list is missing rather than rendering an empty failing set as "nothing failing"', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ failingTests: [] }),
    );
    expect(ev.body).toContain('recorded no failing-file list');
    expect(ev.body).toContain('FAILING ON THE FROZEN CANDIDATE (0)');
  });

  it('ignores blank entries in the failing set so they cannot inflate the count', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ failingTests: ['lib/real.test.ts', '', '   '] }),
    );
    expect(ev.body).toContain('FAILING ON THE FROZEN CANDIDATE (1)');
  });

  it('tags the summary with the pipeline, so a cross-pipeline reader can attribute it', () => {
    const ev = buildFrozenRepairConvergenceBroadcast(
      input({ pipeline: 'email' }),
    );
    expect(ev.summary.startsWith('[email] ')).toBe(true);
  });
});
