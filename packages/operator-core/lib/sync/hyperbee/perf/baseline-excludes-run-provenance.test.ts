/**
 * D-026 safety boundary: per-run provenance may be rich, but committed
 * baselines are release-bundle source and must retain only regression inputs.
 */
import { describe, expect, it } from 'vitest';
import type { PerfArtifact, RunProvenance } from './artifact';
import { currentHostInfo } from './artifact';
import { baselineFromArtifacts } from './compare';

const sentinel = 'provenance-only-sentinel';
const absolutePathSentinel = '/__p2p_provenance_fixture__/private-path';

const provenance: RunProvenance = {
  capturedAt: '2026-08-29T00:00:00.000Z',
  lastCommitSha: sentinel.repeat(2),
  lastCommitAt: '2026-08-28T00:00:00.000Z',
  subjectLastCommitSha: null,
  subjectLastCommitAt: null,
  submodulesDivergedFromGitlink: [`+libs/${sentinel}`],
  worktree: {
    dirtyDigest: sentinel,
    dirtyFileCount: 1,
    dirtyPathsInScope: [`packages/operator-core/${sentinel}.ts`],
    scopedTruncated: false,
    scope: ['packages/operator-core'],
  },
  subjects: [
    {
      dir: 'packages/operator-core',
      fileCount: 1,
      mtimesDigest: sentinel,
      newestMtimeMs: 123,
      newestPath: `packages/operator-core/${sentinel}.ts`,
    },
  ],
  subjectDriftSinceCapture: [`packages/operator-core/${sentinel}`],
  hostAtStart: {
    loadavg1m: 12,
    cpus: 8,
    ratio1m: 1.5,
    psiMemSome60: 9,
    psiCpuSome60: 8,
    swapPagesAtStart: 700,
  },
  hostLoad: {
    loadavg1m: 13,
    cpus: 8,
    ratio1m: 1.6,
    oversubscribed: true,
    swapPagesDelta: 456,
    memoryContended: true,
    memoryContendedReason: 'psi-stall',
    psiMemSome60: 9,
    psiCpuSome60: 8,
  },
  unavailable: [`${sentinel}: ${absolutePathSentinel}`],
};

function artifact(): PerfArtifact {
  return {
    schema: 2,
    provenance,
    scenario: 'merge.idle-tick',
    tier: 1,
    params: { peers: 4 },
    startedAt: '2026-08-29T00:00:00.000Z',
    durationMs: 10,
    host: currentHostInfo(),
    metrics: { latency: { count: 1, max: 1, mean: 1, p50: 1, p95: 1, p99: 1, unit: 'ms' } },
    loopLag: null,
    sloPassed: null,
    sloLimitMs: 100,
    convergence: null,
    convergencePassed: null,
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    notes: [sentinel],
  };
}

describe('baseline projection excludes per-run provenance', () => {
  it('serializes only the explicit baseline allowlist', () => {
    const baseline = baselineFromArtifacts([artifact()], 'ci');
    const serialized = JSON.stringify(baseline);

    expect(Object.keys(baseline)).toEqual(['schema', 'capturedAt', 'profile', 'host', 'entries']);
    expect(Object.keys(baseline.entries[0])).toEqual(['scenario', 'params', 'metrics', 'loopLagP95Ms', 'convergence']);
    expect(serialized).not.toContain('provenance');
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(absolutePathSentinel);
    expect(serialized).not.toContain('dirtyDigest');
    expect(serialized).not.toContain('hostLoad');
  });

  it('uses the non-identifying host tag produced by the sole artifact host writer', () => {
    const host = currentHostInfo();
    const baseline = baselineFromArtifacts([artifact()], 'ci');
    expect(host.hostname).toMatch(/^host-[0-9a-f]{8}$/);
    expect(baseline.host.hostname).toBe(host.hostname);
  });
});
