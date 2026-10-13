import { describe, expect, it } from 'vitest';
import { computeGreenMainSlo, GREEN_MAIN_SLO_DEFAULTS, type GreenMainSloQueue } from './green-main-slo';

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

function queue(overrides: Partial<GreenMainSloQueue> = {}): GreenMainSloQueue {
  return {
    candidate: 'c'.repeat(40),
    openedAtMs: NOW - 20 * H,
    phase: 'ready-to-verify',
    convergenceRounds: [
      { round: 1, head: 'h1', failingCount: 5, atMs: NOW - 19 * H },
      { round: 2, head: 'h2', failingCount: 3, atMs: NOW - 16 * H },
      { round: 3, head: 'h3', failingCount: 4, atMs: NOW - 15 * H },
    ],
    admissions: [
      { atMs: NOW - 18 * H, actor: 'su-a', source: { ref: 'staging', sha: 's1' }, fromRepairHead: 'h1', toRepairHead: 'a1', paths: ['x.ts'], unchanged: [], blobs: {} },
      { atMs: NOW - 15.5 * H, actor: 'su-b', source: { ref: 'staging', sha: 's2' }, fromRepairHead: 'h2', toRepairHead: 'a2', paths: ['y.ts'], unchanged: [], blobs: {} },
    ],
    lastAdmittedAtMs: NOW - 3 * H,
    ...overrides,
  };
}

const base = { installSlug: 'papercusp', nowMs: NOW };

describe('computeGreenMainSlo — metrics from their named populations', () => {
  it('computes all six metrics', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - 30 * H,
      lastVerdictAtMs: NOW - 1 * H,
      queue: queue(),
      syncTallies: [{ fleet: 'drain-a', judgedBatches: 10, redBatches: 1 }],
    });
    expect(slo.metrics.timeSinceGreenMs).toBe(30 * H);
    expect(slo.metrics.timeSinceVerdictMs).toBe(1 * H);
    // Round gaps: 19h→16h = 3h, 16h→15h = 1h. Last is 1h; median of [3h, 1h] is 2h.
    expect(slo.metrics.roundCycleTime).toEqual({ lastMs: 1 * H, medianMs: 2 * H, intervals: 2 });
    // ready-to-verify with an admission no run has started: idle since that admission.
    expect(slo.metrics.queueIdleMs).toBe(3 * H);
    expect(slo.metrics.roundsToConverge).toEqual({ rounds: 3, converged: false });
    // a1 sits between rounds 1 (5) and 2 (3): fewer failures. a2 sits between 2 (3) and 3 (4): red added.
    expect(slo.metrics.redAddingAdmissions).toEqual({ count: 1, judged: 2, heads: ['a2'], attribution: 'window' });
    expect(slo.metrics.perSyncRedRate).toEqual([{ fleet: 'drain-a', judgedBatches: 10, redBatches: 1, rate: 0.1 }]);
  });

  it('idle excludes time inside a running suite: an admission whose run started is not idle', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - H,
      lastVerdictAtMs: NOW - H,
      queue: queue({ lastResumeRunStartedAtMs: NOW - 2 * H }),
    });
    expect(slo.metrics.queueIdleMs).toBe(0);
  });

  it('a red awaiting a fixer counts as idle from the newest red', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - H,
      lastVerdictAtMs: NOW - H,
      queue: queue({ phase: 'awaiting-fixer', lastAdmittedAtMs: undefined }),
    });
    expect(slo.metrics.queueIdleMs).toBe(15 * H);
  });

  it('reports unknown as null, never as zero or an empty list', () => {
    const slo = computeGreenMainSlo({ ...base, lastGreenAtMs: null, lastVerdictAtMs: null, queue: null, syncTallies: null });
    expect(slo.metrics.timeSinceGreenMs).toBeNull();
    expect(slo.metrics.timeSinceVerdictMs).toBeNull();
    expect(slo.metrics.queueIdleMs).toBeNull();
    expect(slo.metrics.roundsToConverge).toBeNull();
    expect(slo.metrics.redAddingAdmissions).toBeNull();
    expect(slo.metrics.perSyncRedRate).toBeNull();
    expect(slo.breaches).toEqual([]);
  });

  it('a fleet with no judged batches has a null rate, not 0%', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW,
      lastVerdictAtMs: NOW,
      queue: null,
      syncTallies: [{ fleet: null, judgedBatches: 0, redBatches: 0 }],
    });
    expect(slo.metrics.perSyncRedRate?.[0].rate).toBeNull();
  });
});

describe('computeGreenMainSlo — owner pages (AUTO-BAR-R-14)', () => {
  const pages = (lastGreenAtMs: number | null, lastVerdictAtMs: number | null) =>
    computeGreenMainSlo({ ...base, lastGreenAtMs, lastVerdictAtMs, queue: null }).breaches.filter((b) => b.severity === 'page');

  it('pages the owner once main has been red for 12 hours', () => {
    const [page] = pages(NOW - 12 * H, NOW - H);
    expect(page.metric).toBe('time-since-green');
    expect(page.episodeKey).toBe(`green-main-slo:papercusp:time-since-green:${NOW - 12 * H}`);
  });

  it('does not page at 11h59m red', () => {
    expect(pages(NOW - 12 * H + 60_000, NOW - H)).toEqual([]);
  });

  it('pages after 6 hours with no verdict of any kind', () => {
    const [page] = pages(NOW - H, NOW - 6 * H);
    expect(page.metric).toBe('time-since-verdict');
    expect(page.episodeKey).toBe(`green-main-slo:papercusp:time-since-verdict:${NOW - 6 * H}`);
  });

  it('does not page at 5h59m without a verdict, or on a gate that never rendered one', () => {
    expect(pages(NOW - H, NOW - 6 * H + 60_000)).toEqual([]);
    expect(pages(null, null)).toEqual([]);
  });

  it('keeps one episode key for the whole red episode, and a new key after a new green', () => {
    const lastGreen = NOW - 13 * H;
    const at12 = computeGreenMainSlo({ ...base, nowMs: lastGreen + 12 * H, lastGreenAtMs: lastGreen, lastVerdictAtMs: null, queue: null });
    const at40 = computeGreenMainSlo({ ...base, nowMs: lastGreen + 40 * H, lastGreenAtMs: lastGreen, lastVerdictAtMs: null, queue: null });
    expect(at40.breaches[0].episodeKey).toBe(at12.breaches[0].episodeKey);
    const nextEpisode = computeGreenMainSlo({ ...base, nowMs: NOW + 20 * H, lastGreenAtMs: NOW, lastVerdictAtMs: null, queue: null });
    expect(nextEpisode.breaches[0].episodeKey).not.toBe(at12.breaches[0].episodeKey);
  });

  it('pages on both limbs at once when main is red and the gate is also silent', () => {
    expect(pages(NOW - 13 * H, NOW - 7 * H).map((p) => p.metric)).toEqual(['time-since-green', 'time-since-verdict']);
  });
});

describe('computeGreenMainSlo — alerts on breach (AUTO-BAR-R-13)', () => {
  const alerts = (input: Parameters<typeof computeGreenMainSlo>[0]) =>
    computeGreenMainSlo(input).breaches.filter((b) => b.severity === 'alert').map((b) => b.metric);

  it('alerts on a slow round, an idle queue, a red-adding admission and a red-heavy fleet', () => {
    const q = queue({
      convergenceRounds: [
        { round: 1, head: 'h1', failingCount: 3, atMs: NOW - 10 * H },
        { round: 2, head: 'h2', failingCount: 6, atMs: NOW - 5 * H },
      ],
      admissions: [{ atMs: NOW - 8 * H, actor: 'su-a', source: { ref: 'staging', sha: 's' }, fromRepairHead: 'h1', toRepairHead: 'a9', paths: [], unchanged: [], blobs: {} }],
    });
    expect(
      alerts({ ...base, lastGreenAtMs: NOW - H, lastVerdictAtMs: NOW - H, queue: q, syncTallies: [{ fleet: 'f', judgedBatches: 10, redBatches: 3 }] }),
    ).toEqual(['round-cycle-time', 'queue-idle', 'red-adding-admission', 'per-sync-red-rate']);
  });

  it('raises nothing when every metric is inside its target', () => {
    const q = queue({
      convergenceRounds: [
        { round: 1, head: 'h1', failingCount: 3, atMs: NOW - 2 * H },
        { round: 2, head: 'h2', failingCount: 1, atMs: NOW - 1 * H },
      ],
      admissions: [],
      lastAdmittedAtMs: NOW - 30 * 60_000,
    });
    expect(
      alerts({ ...base, lastGreenAtMs: NOW - H, lastVerdictAtMs: NOW - H, queue: q, syncTallies: [{ fleet: 'f', judgedBatches: 10, redBatches: 2 }] }),
    ).toEqual([]);
  });

  it('does not call a red rate over too few batches a breach', () => {
    expect(
      alerts({ ...base, lastGreenAtMs: NOW, lastVerdictAtMs: NOW, queue: null, syncTallies: [{ fleet: 'f', judgedBatches: GREEN_MAIN_SLO_DEFAULTS.perSyncRedMinBatches - 1, redBatches: 4 }] }),
    ).toEqual([]);
  });
});
