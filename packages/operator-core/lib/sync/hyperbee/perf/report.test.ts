/**
 * Tests for renderPerfReport — the pure per-run markdown renderer for the
 * p2p-perf suite (artifacts in → report.md out).
 * Run with: cd packages/operator-core && npx vitest run lib/sync/hyperbee/perf/report.test.ts
 */
import { describe, expect, it } from 'vitest';
import { renderPerfReport } from './report';
import type { PerfArtifact } from './artifact';

const artifact = (over: Partial<PerfArtifact> = {}): PerfArtifact =>
  ({
    tier: 1,
    scenario: 'merge-cost',
    params: { peers: 4 },
    metrics: { mergeMs: { count: 10, p95: 12.5, unit: 'ms' } },
    sloPassed: true,
    notes: [],
    loopLag: { p95Ms: 8 },
    host: { hostname: 'box', platform: 'linux', cpus: 8, node: 'v25' },
    ...over,
  }) as unknown as PerfArtifact;

describe('renderPerfReport', () => {
  it('renders the header with run id, profile, host, and artifact count', () => {
    const out = renderPerfReport({ runId: 'run-1', profile: 'smoke', artifacts: [artifact()] });
    expect(out).toContain('# p2p-perf run `run-1`');
    expect(out).toContain('- profile: **smoke**');
    expect(out).toContain('- host: box (linux, 8 cpus, node v25)');
    expect(out).toContain('- artifacts: 1');
  });

  it('derives the title suffix from the tiers present, and honors an override', () => {
    expect(renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact({ tier: 2 })] })).toContain('— tier 2');
    expect(renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact()], titleSuffix: 'Tier 3 — real frames' }))
      .toContain('— Tier 3 — real frames');
  });

  it('renders a table row with params, headline metric, loop-lag and SLO', () => {
    const out = renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact()] });
    expect(out).toContain('| merge-cost | 1 | peers=4 | mergeMs: 12.5 ms | 8 ms | ✓ |');
  });

  it('shows — for the metric when no metric has a positive count', () => {
    const out = renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact({ metrics: { x: { count: 0, p95: 0, unit: 'ms' } } as never })] });
    expect(out).toMatch(/\| merge-cost \| 1 \| peers=4 \| — \|/);
  });

  it('maps sloPassed null→n/a and false→✖', () => {
    expect(renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact({ sloPassed: null })] })).toContain('| n/a |');
    expect(renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact({ sloPassed: false })] })).toContain('| **✖** |');
  });

  it('appends the advisory baseline comparison block when compareText is given', () => {
    const out = renderPerfReport({ runId: 'r', profile: 'p', artifacts: [artifact()], compareText: 'baseline: +3%' });
    expect(out).toContain('## Baseline comparison (advisory — D-005)');
    expect(out).toContain('baseline: +3%');
  });

  it('falls back to host "(none)" for an empty artifact set', () => {
    const out = renderPerfReport({ runId: 'r', profile: 'p', artifacts: [] });
    expect(out).toContain('- host: (none)');
    expect(out).toContain('- artifacts: 0');
  });
});
