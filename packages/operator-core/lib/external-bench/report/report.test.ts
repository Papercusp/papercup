/**
 * Benchmark report builder tests (plan benchmark-report-portable-trace-2026-06-17).
 * Pure — no PG, no fs reads of run data (buildReportHtml reads only the committed viewer template).
 */
import { describe, it, expect } from 'vitest';
import { bundleFromRollouts, buildReportHtml } from './report-builder';
import { BENCH_REPORT_SCHEMA_VERSION } from './report-schema';

function rr(over: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    arm: 'a',
    seed: 0,
    resolved: true,
    graderStatus: 'passed',
    generationStatus: 'completed',
    stopReason: 'done',
    costUsd: 1,
    tokensIn: 10,
    tokensOut: 20,
    tokensTotal: 30,
    wallClockMs: 100,
    ...over,
  };
}

describe('bundleFromRollouts', () => {
  it('computes per-arm resolved/scored + totals, excluding infra rows from the denominator', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'],
      models: { a: 'claude-opus-4-8[1m]' },
      runResults: [
        rr({ taskId: 't1', resolved: true }),
        rr({ taskId: 't2', resolved: false, graderStatus: 'failed' }),
        // infra/transient → excluded from scored, surfaced as infraExcluded (resolved=null)
        rr({ taskId: 't3', resolved: null, generationStatus: 'error', graderStatus: 'error', stopReason: 'infra-failed' }),
      ],
    });
    const a = b.arms[0];
    expect(a.resolved).toBe(1);
    expect(a.scored).toBe(2); // t1 + t2; t3 excluded
    expect(a.infraExcluded).toBe(1);
    expect(b.run.totals.tasks).toBe(3);
    expect(b.run.totals.costUsd).toBe(3);
    expect(b.schemaVersion).toBe(BENCH_REPORT_SCHEMA_VERSION);
    expect(b.rollouts).toHaveLength(3);
  });

  it('computes meanScore over scored rows for partial-credit suites', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'the-agent-company', createdAt: '2026-06-17', arms: ['hive'],
      models: { hive: 'claude-opus-4-8[1m]' },
      runResults: [
        rr({ arm: 'hive', taskId: 't1', resolved: false, score: 0.4, graderStatus: 'failed' }),
        rr({ arm: 'hive', taskId: 't2', resolved: true, score: 1.0, graderStatus: 'passed' }),
      ],
    });
    expect(b.arms[0].meanScore).toBeCloseTo(0.7, 10);
  });

  it('joins a rollout record to its run-result (replay fingerprint carried onto the row)', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'],
      models: { a: 'm' },
      runResults: [rr({ taskId: 't1', arm: 'a', seed: 0 })],
      rollouts: [{
        rolloutId: 'roll-1', taskId: 't1', arm: 'a', seed: 0,
        modelId: 'claude-opus-4-8[1m]', harnessVersion: 'ext-bench@abc', harnessGitSha: 'deadbeef',
        submission: 'diff --git a/x b/x', rawGraderOutput: '{"resolved":true}', trajectoryRef: 'xbench://traj-1',
        configSnapshot: { tier: 'max' },
      }],
    });
    const row = b.rollouts[0];
    expect(row.rolloutId).toBe('roll-1');
    expect(row.modelId).toBe('claude-opus-4-8[1m]');
    expect(row.harnessGitSha).toBe('deadbeef');
    expect(row.submission).toContain('diff --git');
    expect(row.trajectoryRef).toBe('xbench://traj-1');
    expect((row.configSnapshot as { tier: string }).tier).toBe('max');
  });

  it('summarizes per-arm concurrency from a timeline', () => {
    const b = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
      runResults: [rr()],
      concurrencyTimeline: { a: [{ tMs: 0, live: 1 }, { tMs: 1, live: 2 }, { tMs: 2, live: 2 }] },
    });
    expect(b.arms[0].concurrency?.peak).toBe(2);
    expect(b.arms[0].concurrency?.avg).toBeCloseTo(5 / 3, 10);
  });
});

describe('buildReportHtml', () => {
  const b = bundleFromRollouts({
    runId: 'run-xyz', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
    runResults: [rr()],
    suiteData: { foo: 'bar' },
  });

  it('produces a self-contained HTML with the bundle injected as window.__BENCH_REPORT__', () => {
    const html = buildReportHtml(b);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('window.__BENCH_REPORT__=');
    expect(html).toContain('run-xyz');
    // NO external script/style src (portable, offline) — only inline <script>/<style>.
    expect(/<script\s+src=/i.test(html)).toBe(false);
    expect(/<link\s+[^>]*href=/i.test(html)).toBe(false);
  });

  it('escapes < in the injected JSON so it cannot break out of the script tag', () => {
    const withTag = bundleFromRollouts({
      runId: 'r', suite: 'swe-bench-pro', createdAt: '2026-06-17', arms: ['a'], models: { a: 'm' },
      runResults: [rr({ taskId: 't1' })],
      rollouts: [{ rolloutId: 'x', taskId: 't1', arm: 'a', seed: 0, modelId: 'm', harnessVersion: 'h',
        submission: '</script><script>alert(1)</script>' }],
    });
    const html = buildReportHtml(withTag);
    // the raw closing-tag injection must NOT appear verbatim in the injected data
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});
