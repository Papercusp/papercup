/**
 * portable-identity-packages-2026-09-26 P-010 — package-declared orientation
 * classes render into the orientation block from the REAL sink evaluator's result.
 *
 * Every case drives `evaluateSinkInvocation` (no hand-built result), then renders
 * through `composeOrientationBlockWithPackages`. The asserted contract: the
 * platform half is byte-identical with or without packages, package rows follow
 * it in priority order under their own budget, failures are visible, stale
 * results are fenced out, and a class applies only to its own sink.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { InjectionPoint } from '@papercusp/orchestrator/blueprint';
import { composeOrientationBlockWithRows, fingerprintOrientation, type OrientationState } from '../turn-start-orientation';
import {
  composeOrientationBlockWithPackages,
  fitPackageOrientationRows,
  isPackageOrientationClassId,
  ORIENTATION_BLOCK_HEADER,
  PACKAGE_ORIENTATION_MAX_ROWS,
  PACKAGE_ORIENTATION_ORDER_BASE,
  packageOrientationClasses,
  projectPackageOrientationRows,
} from './package-orientation-classes';
import {
  evaluateSinkInvocation,
  resetSinkEvaluatorForTests,
  type SinkContributionRequest,
  type SinkHostLimits,
} from './sink-evaluator';

const LIMITS: SinkHostLimits = {
  sinkBudget: { tokens: 60, wallClockMs: 2_000 },
  turnCeiling: { tokens: 10_000, wallClockMs: 60_000 },
  perSessionConcurrency: 2,
};
const FENCE = { sessionId: 'sess-p010', turnId: 'turn-1', attachmentRevision: 'rev-1' };
let seq = 0;

function point(tokenBudget: number, priority: number, sink: 'turn-start' | 'agent-orders' = 'turn-start'): InjectionPoint {
  return { sinks: [sink], trigger: 'every-turn', tokenBudget, priority, overBudget: 'truncate' };
}

function says(identityId: string, text: string, tokenBudget: number, priority: number): SinkContributionRequest {
  return { identityId, contributionId: 'ctx', injection: point(tokenBudget, priority), produce: async () => text };
}

async function evaluate(contributions: SinkContributionRequest[], sink: 'turn-start' | 'agent-orders' = 'turn-start') {
  return evaluateSinkInvocation({
    invocation: { ...FENCE, invocationId: `inv-${++seq}`, sink },
    contributions,
    limits: LIMITS,
    currentAttachmentRevision: () => FENCE.attachmentRevision,
  });
}

function platformState(extra: Partial<OrientationState> = {}): OrientationState {
  return {
    planDecisions: undefined,
    lockTransitions: undefined,
    coupledPeers: null,
    held: [],
    unansweredDirected: 0,
    unansweredStale: 0,
    inboxRecent: [],
    openAsks: null,
    announcedGates: [],
    modes: [],
    authorityVerdict: null,
    loopArmed: true,
    loopFireWithheld: false,
    improvementTriage: null,
    executableFrontier: null,
    neverDropFacts: [],
    toolSurface: null,
    carryBlindWindow: null,
    ...extra,
  } as OrientationState;
}

/** A platform state that renders: one directed message awaiting an answer. */
const SPEAKING = platformState({ unansweredDirected: 1, inboxRecent: [{ msgId: 'm-1', from: 'su-peer', summary: 'answer me' }] });

afterEach(() => resetSinkEvaluatorForTests());

describe('P-010 — package-declared orientation classes', () => {
  it('platform rows are byte-identical with packages; package rows follow them in priority order', async () => {
    const result = await evaluate([
      says('id.low', 'LOW-PRIORITY NOTE', 20, 10),
      says('id.high', 'HIGH-PRIORITY NOTE', 20, 90),
    ]);
    const packages = packageOrientationClasses(result, FENCE);
    expect(packages.map((c) => c.id)).toEqual(['package:id.high/ctx', 'package:id.low/ctx']);
    expect(packages.every((c) => isPackageOrientationClassId(c.id))).toBe(true);
    expect(packages[0].order).toBe(PACKAGE_ORIENTATION_ORDER_BASE);

    const input = { state: SPEAKING, committed: null, epoch: 1 };
    const alone = composeOrientationBlockWithRows(input);
    const withPackages = composeOrientationBlockWithPackages({ ...input, packages });
    expect(alone.block.length).toBeGreaterThan(0);
    expect(alone.block.startsWith(ORIENTATION_BLOCK_HEADER)).toBe(true);
    expect(withPackages.baseBlock).toBe(alone.block);
    expect(withPackages.rows).toEqual(alone.rows);
    expect(withPackages.block.startsWith(`${alone.block}\n`)).toBe(true);
    const tail = withPackages.block.slice(alone.block.length + 1).split('\n');
    expect(tail).toEqual(['- 📦 id.high/ctx: HIGH-PRIORITY NOTE', '- 📦 id.low/ctx: LOW-PRIORITY NOTE']);
  });

  it('adding providers never evicts a platform row, and an unfunded contribution renders its omission marker', async () => {
    // The sink budget is 60 tokens; the first two requests consume it, so the third is never funded.
    const result = await evaluate([
      says('id.a', 'A'.repeat(120), 30, 80),
      says('id.b', 'B'.repeat(120), 30, 70),
      says('id.c', 'C-NEVER-RUNS', 30, 60),
    ]);
    const packages = packageOrientationClasses(result, FENCE);
    const input = { state: SPEAKING, committed: null, epoch: 1 };
    const withPackages = composeOrientationBlockWithPackages({ ...input, packages });
    expect(withPackages.baseBlock).toBe(composeOrientationBlockWithRows(input).block);
    expect(withPackages.block).not.toContain('C-NEVER-RUNS');
    expect(withPackages.block).toContain('⟦id.c/ctx omitted: budget-exhausted⟧');
    const funded = result.allocation.reduce((sum, slot) => sum + slot.allowance, 0);
    expect(funded).toBeLessThanOrEqual(LIMITS.sinkBudget.tokens);
  });

  it('package rows spend their own budget, disclosing a cut; the platform half is unchanged', async () => {
    const result = await evaluate([says('id.big', Array.from({ length: 8 }, (_, i) => `line ${i} ${'y'.repeat(30)}`).join('\n'), 60, 50)]);
    const packages = packageOrientationClasses(result, FENCE);
    const input = { state: SPEAKING, committed: null, epoch: 1 };
    const tight = composeOrientationBlockWithPackages({ ...input, packages, packageBudgetChars: 140 });
    expect(tight.baseBlock).toBe(composeOrientationBlockWithRows(input).block);
    const packageText = tight.packageRows.map((row) => row.text);
    expect(packageText.reduce((sum, text) => sum + text.length + 1, 0)).toBeLessThanOrEqual(140);
    expect(packageText.at(-1)).toMatch(/^- 📦 \+\d+ package row\(s\) omitted — over the 140-char package budget$/);
  });

  it('a class that exceeds its row ceiling renders a visible +N omitted disclosure', async () => {
    const many = Array.from({ length: PACKAGE_ORIENTATION_MAX_ROWS + 3 }, (_, i) => `r${i}`).join('\n');
    const result = await evaluate([says('id.many', many, 60, 50)]);
    const rows = projectPackageOrientationRows(packageOrientationClasses(result, FENCE), 'turn-start');
    expect(rows).toHaveLength(PACKAGE_ORIENTATION_MAX_ROWS + 1);
    expect(rows.at(-1)!.text).toMatch(/^- package:id\.many\/ctx: \+3 omitted — /);
  });

  it('a result from another turn, session or attachment revision is fenced out', async () => {
    const result = await evaluate([says('id.x', 'STALE TEXT', 20, 50)]);
    expect(packageOrientationClasses(result, FENCE)).toHaveLength(1);
    expect(packageOrientationClasses(result, { ...FENCE, turnId: 'turn-2' })).toEqual([]);
    expect(packageOrientationClasses(result, { ...FENCE, sessionId: 'sess-other' })).toEqual([]);
    expect(packageOrientationClasses(result, { ...FENCE, attachmentRevision: 'rev-2' })).toEqual([]);
    expect(packageOrientationClasses(null, FENCE)).toEqual([]);
  });

  it('a class applies only to its own sink', async () => {
    const orders = await evaluate([says('id.o', 'ORDERS ONLY', 20, 50)], 'agent-orders');
    const classes = packageOrientationClasses(orders, FENCE);
    expect(projectPackageOrientationRows(classes, 'agent-orders').map((r) => r.text)).toEqual(['- 📦 id.o/ctx: ORDERS ONLY']);
    expect(projectPackageOrientationRows(classes, 'turn-start')).toEqual([]);
    expect(composeOrientationBlockWithPackages({ state: SPEAKING, committed: null, epoch: 1, packages: classes }).block)
      .not.toContain('ORDERS ONLY');
  });

  it('package rows render under the header even when the platform half is silent (unchanged since last turn)', async () => {
    const result = await evaluate([says('id.q', 'QUIET-TURN NOTE', 20, 50)]);
    const quiet = platformState();
    const committed = fingerprintOrientation(quiet, 1);
    expect(composeOrientationBlockWithRows({ state: quiet, committed, epoch: 1 }).block).toBe('');
    const out = composeOrientationBlockWithPackages({ state: quiet, committed, epoch: 1, packages: packageOrientationClasses(result, FENCE) });
    expect(out.baseBlock).toBe('');
    expect(out.block).toBe(`${ORIENTATION_BLOCK_HEADER}\n- 📦 id.q/ctx: QUIET-TURN NOTE`);
  });

  it('fitPackageOrientationRows keeps every row when they fit and never exceeds the budget otherwise', () => {
    const rows = ['aaaa', 'bbbb', 'cccc'].map((text, i) => ({ classId: 'package:x/y' as const, order: i, text }));
    expect(fitPackageOrientationRows(rows, 100)).toEqual(rows);
    for (const budget of [0, 5, 10, 60, 70]) {
      const fitted = fitPackageOrientationRows(rows, budget);
      expect(fitted.reduce((sum, row) => sum + row.text.length + 1, 0)).toBeLessThanOrEqual(budget);
    }
  });
});
