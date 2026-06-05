import { describe, it, expect, vi } from 'vitest';
import {
  collectTraceByStrategy,
  strategyRequiresRepo,
  BUILTIN_COLLECT_STRATEGIES,
  type TraceCollectDeps,
} from '../collect-strategies';
import type { RunOutputRow } from '../collector';

/**
 * P-014 — the per-blueprint collectTrace seam (D-015). Breaks the gym's repo-coupling:
 * `git-diff` (coding) still works; `work-item-output` (research/gym) collects a trace
 * with NO git, NO clone — the requiresRepo:false path.
 */

const RUN_OUTPUTS: RunOutputRow[] = [
  { runId: 'r1', role: 'worker', outBody: 'did the thing' },
  { runId: 'r2', role: 'validator', outBody: 'looks right' },
];

function baseDeps(over: Partial<TraceCollectDeps> = {}): TraceCollectDeps {
  return {
    readRunOutputs: async () => RUN_OUTPUTS,
    writeBundle: async (text) => `/scratch/${text.length}.json`,
    ...over,
  };
}

describe('strategyRequiresRepo', () => {
  it('only git-diff needs a repo', () => {
    expect(strategyRequiresRepo('git-diff')).toBe(true);
    expect(strategyRequiresRepo('work-item-output')).toBe(false);
    expect(strategyRequiresRepo('some-custom')).toBe(false);
    expect(BUILTIN_COLLECT_STRATEGIES).toEqual(['git-diff', 'work-item-output']);
  });
});

describe('git-diff strategy (coding — zero-regression path)', () => {
  it('builds the RawTrace from the clone diff + run outputs', async () => {
    const gitDiff = vi.fn(async () => 'diff --git a/x b/x\n+added');
    const { rawTrace, strategy } = await collectTraceByStrategy(
      'git-diff',
      { harnessSlug: 'h1', terminalState: 'done', clonePath: '/clone', baseCommit: 'abc1234' },
      baseDeps({ gitDiff }),
    );
    expect(strategy).toBe('git-diff');
    expect(gitDiff).toHaveBeenCalledWith('/clone', 'abc1234');
    expect(rawTrace.diff).toContain('+added');
    expect(rawTrace.roleTranscripts.map((t) => t.role)).toEqual(['worker', 'validator']);
    expect(rawTrace.terminalState).toBe('done');
  });

  it('rejects a non-pinned base commit (a ref/branch, not a SHA)', async () => {
    await expect(
      collectTraceByStrategy(
        'git-diff',
        { harnessSlug: 'h1', terminalState: 'done', clonePath: '/clone', baseCommit: 'main' },
        baseDeps({ gitDiff: async () => '' }),
      ),
    ).rejects.toThrow(/pinned hex SHA/);
  });

  it('errors clearly when no gitDiff effect is wired', async () => {
    await expect(
      collectTraceByStrategy('git-diff', { harnessSlug: 'h1', terminalState: 'done', clonePath: '/c', baseCommit: 'abc1234' }, baseDeps()),
    ).rejects.toThrow(/no gitDiff effect/);
  });
});

describe('work-item-output strategy (research / gym — requiresRepo:false path)', () => {
  it('collects a trace with NO git dep at all (the repo-less acceptance path)', async () => {
    // Deliberately pass deps with NO gitDiff — a repo-less harness has no clone.
    const readWorkItemOutput = vi.fn(async () => 'FINDINGS: the answer is 42');
    const { rawTrace, traceRef, strategy } = await collectTraceByStrategy(
      'work-item-output',
      { harnessSlug: 'r1', terminalState: 'done', workItemId: 'R-001' },
      baseDeps({ readWorkItemOutput }),
    );
    expect(strategy).toBe('work-item-output');
    expect(readWorkItemOutput).toHaveBeenCalledWith('r1', 'R-001');
    // the produced work-item output IS the primary artifact (the "diff" slot)
    expect(rawTrace.diff).toBe('FINDINGS: the answer is 42');
    expect(rawTrace.roleTranscripts).toHaveLength(2);
    expect(traceRef).toMatch(/\/scratch\//);
  });

  it('still produces a valid trace when no work-item reader is wired (transcripts only)', async () => {
    const { rawTrace } = await collectTraceByStrategy(
      'work-item-output',
      { harnessSlug: 'r1', terminalState: 'escalate' },
      baseDeps(), // no readWorkItemOutput, no gitDiff
    );
    expect(rawTrace.diff).toBe('');
    expect(rawTrace.roleTranscripts).toHaveLength(2);
    expect(rawTrace.terminalState).toBe('escalate');
  });

  it('carries deterministic signals through into the trace', async () => {
    const { rawTrace } = await collectTraceByStrategy(
      'work-item-output',
      { harnessSlug: 'r1', terminalState: 'done', signals: { plantedBugCaught: true } },
      baseDeps(),
    );
    expect(rawTrace.signals).toEqual({ plantedBugCaught: true });
  });
});

describe('unknown strategy', () => {
  it('throws (never silently empty) on an unregistered custom strategy', async () => {
    await expect(
      collectTraceByStrategy('telepathy', { harnessSlug: 'h1', terminalState: 'done' }, baseDeps()),
    ).rejects.toThrow(/unknown strategy "telepathy"/);
  });
});
