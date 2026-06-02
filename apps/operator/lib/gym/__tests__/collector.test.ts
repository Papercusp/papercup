import { describe, it, expect } from 'vitest';
import { buildDiffCommand, assembleRawTrace, collectTrace, type CollectDeps, type RunOutputRow } from '../collector';

/**
 * Trace collector (P-002): assemble the run's RawTrace from the per-role transcripts
 * (harness_run_output) + the produced diff (git diff <base> HEAD in the clone), to
 * feed distillTrace → the judge. Pure cores + a DI orchestration; the PG read + git
 * exec + bundle-file write are the injected effects (validated with the live worker
 * at P-014).
 */
describe('buildDiffCommand', () => {
  it('builds `git -C <clone> diff <base> HEAD`', () => {
    const { argv } = buildDiffCommand('/scratch/gym/clones/gymabc', '0123456789abcdef0123456789abcdef01234567');
    expect(argv).toEqual(['git', '-C', '/scratch/gym/clones/gymabc', 'diff', '0123456789abcdef0123456789abcdef01234567', 'HEAD']);
  });
  it('throws when the base commit is not a pinned SHA', () => {
    expect(() => buildDiffCommand('/c', 'main')).toThrow();
  });
});

describe('assembleRawTrace', () => {
  const runOutputs: RunOutputRow[] = [
    { runId: 'r1', role: 'worker', outBody: 'added the endpoint' },
    { runId: 'r2', role: 'validator', outBody: '[PASS]' },
  ];

  it('maps run-output rows to role transcripts and carries diff/terminal/signals', () => {
    const t = assembleRawTrace({
      diff: 'diff --git a/x b/x',
      runOutputs,
      terminalState: 'passed',
      signals: { regressions: false },
    });
    expect(t.diff).toBe('diff --git a/x b/x');
    expect(t.terminalState).toBe('passed');
    expect(t.signals).toEqual({ regressions: false });
    expect(t.roleTranscripts).toEqual([
      { role: 'worker', runId: 'r1', text: 'added the endpoint' },
      { role: 'validator', runId: 'r2', text: '[PASS]' },
    ]);
  });

  it('handles no run outputs', () => {
    const t = assembleRawTrace({ diff: '', runOutputs: [], terminalState: 'errored' });
    expect(t.roleTranscripts).toEqual([]);
  });
});

describe('collectTrace', () => {
  it('reads transcripts + diff, assembles, and writes a bundle returning its ref', async () => {
    const calls: string[] = [];
    const deps: CollectDeps = {
      async readRunOutputs(slug) { calls.push(`read:${slug}`); return [{ runId: 'r1', role: 'worker', outBody: 'w' }]; },
      async gitDiff(clonePath, base) { calls.push(`diff:${clonePath}@${base}`); return 'THE DIFF'; },
      async writeBundle(text) { calls.push('write'); return `/gym/traces/${text.length}.txt`; },
    };
    const out = await collectTrace(
      { harnessSlug: 'gymabc', clonePath: '/c', baseCommit: '0123456789abcdef0123456789abcdef01234567', terminalState: 'passed', signals: { regressions: false } },
      deps,
    );
    expect(out.rawTrace.diff).toBe('THE DIFF');
    expect(out.rawTrace.roleTranscripts[0].role).toBe('worker');
    expect(out.traceRef).toMatch(/^\/gym\/traces\//);
    expect(calls).toEqual(['read:gymabc', 'diff:/c@0123456789abcdef0123456789abcdef01234567', 'write']);
  });
});
