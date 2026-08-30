/**
 * Tests for renderPerfReport — the pure per-run markdown renderer for the
 * p2p-perf suite (artifacts in → report.md out).
 * Run with: cd packages/operator-core && npx vitest run lib/sync/hyperbee/perf/report.test.ts
 */
import { describe, expect, it } from 'vitest';
import { renderPerfReport } from './report';
import type { PerfArtifact, RunProvenance } from './artifact';

const artifact = (over: Partial<PerfArtifact> = {}): PerfArtifact =>
  ({
    schema: 2,
    provenance: null,
    tier: 1,
    scenario: 'merge-cost',
    params: { peers: 4 },
    startedAt: '2026-08-29T00:00:00.000Z',
    durationMs: 10,
    metrics: { mergeMs: { count: 10, p95: 12.5, unit: 'ms' } },
    sloPassed: true,
    sloLimitMs: 100,
    convergence: null,
    convergencePassed: null,
    notes: [],
    loopLag: { p95Ms: 8 },
    host: { hostname: 'box', platform: 'linux', arch: 'x64', cpus: 8, node: 'v25' },
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    ...over,
  }) as unknown as PerfArtifact;

const provenance = (over: Partial<RunProvenance> = {}): RunProvenance => ({
  capturedAt: '2026-08-29T00:00:00.000Z',
  lastCommitSha: '1234567890abcdef1234567890abcdef12345678',
  lastCommitAt: '2026-08-28T00:00:00.000Z',
  subjectLastCommitSha: null,
  subjectLastCommitAt: null,
  submodulesDivergedFromGitlink: [],
  worktree: {
    dirtyDigest: 'aabbccddeeff0011',
    dirtyFileCount: 0,
    dirtyPathsInScope: [],
    scopedTruncated: false,
    scope: ['packages/operator-core/lib/sync/hyperbee'],
  },
  subjects: [
    {
      dir: 'packages/operator-core/lib/sync/hyperbee',
      fileCount: 10,
      mtimesDigest: 'ffeeddccbbaa0011',
      newestMtimeMs: 1,
      newestPath: 'packages/operator-core/lib/sync/hyperbee/index.ts',
    },
  ],
  subjectDriftSinceCapture: [],
  hostAtStart: {
    loadavg1m: 4,
    cpus: 8,
    ratio1m: 0.5,
    psiMemSome60: 1,
    psiCpuSome60: 2,
    swapPagesAtStart: 100,
  },
  hostLoad: {
    loadavg1m: 5,
    cpus: 8,
    ratio1m: 0.75,
    oversubscribed: false,
    swapPagesDelta: 321,
    memoryContended: false,
    memoryContendedReason: null,
    psiMemSome60: 1.5,
    psiCpuSome60: 2.5,
  },
  unavailable: [],
  ...over,
});

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

  it('labels the commit as last-commit-not-tree-state and renders final host evidence from the artifact', () => {
    const out = renderPerfReport({
      runId: 'r',
      profile: 'p',
      artifacts: [artifact({ provenance: provenance() })],
    });
    expect(out).toContain('last commit `1234567890ab`');
    expect(out).toContain('LAST COMMIT, not tree state');
    expect(out).toContain('host over run: loadavg(end) 5.0 / 8 cpus (max ratio 0.75×)');
    expect(out).toContain('swap Δ 321 pages');
    expect(out).toContain('PSI some avg60(max) mem=1.5% cpu=2.5%');
  });

  it('warns when final host evidence or the per-artifact drift probe is unknown', () => {
    const out = renderPerfReport({
      runId: 'r',
      profile: 'p',
      artifacts: [
        artifact({
          provenance: provenance({ hostLoad: null, subjectDriftSinceCapture: null }),
        }),
      ],
    });
    expect(out).toContain('subject drift: **not fully probed**');
    expect(out).toContain('host over run: **not finalized**');
  });

  it('does not let one attributed artifact hide an unattributed artifact in the same report', () => {
    const out = renderPerfReport({
      runId: 'r',
      profile: 'p',
      artifacts: [artifact({ provenance: provenance() }), artifact({ scenario: 'second', provenance: null })],
    });
    expect(out).toContain('provenance coverage: **1/2 artifact(s) UNATTRIBUTED**');
  });
});
