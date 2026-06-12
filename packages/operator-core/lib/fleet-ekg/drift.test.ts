/**
 * drift.test.ts — the EKG's pure shift detector + attribution (P-030 /
 * FB-10). Pins PSI/JSD math, cohort floors, severity thresholds, direction,
 * and the D-003 ledger attribution window — all on synthetic cohorts.
 */
import { describe, expect, it } from 'vitest';
import type { BehaviorChangeRow } from '../change-ledger/change-ledger';
import type { SessionVector } from './features';
import {
  attributeFindings,
  ATTRIBUTION_LOOKBACK_MS,
  detectDrift,
  DRIFT_DEFAULTS,
  jsd,
  psi,
} from './drift';

const T0 = 1_750_000_000_000;

/** A cohort of near-identical sessions, with overridable feature values. */
function cohort(
  n: number,
  features: (i: number) => Record<string, number>,
  mix: Record<string, number> = { read: 5, bash: 3, edit: 2 },
  bigrams: Record<string, number> = { 'read>bash': 4, 'bash>edit': 3 },
): SessionVector[] {
  return Array.from({ length: n }, (_, i) => ({
    ownerId: `su-${i}`,
    sessionId: `sess-${i}`,
    agent: 'claude',
    harnessSlug: null,
    startedAtMs: T0,
    endedAtMs: T0 + 3600_000,
    eventCount: 20,
    features: features(i),
    toolMix: { ...mix },
    bigrams: { ...bigrams },
  }));
}

/** Baseline-like numeric features with mild noise. */
const baseFeatures = (i: number): Record<string, number> => ({
  eventCount: 20 + (i % 5),
  errorRate: 0.05 + (i % 3) * 0.01,
  medianGapMs: 1000 + (i % 7) * 50,
});

describe('psi', () => {
  it('≈0 for same-distribution cohorts', () => {
    const a = Array.from({ length: 200 }, (_, i) => (i % 20) * 10);
    const b = Array.from({ length: 100 }, (_, i) => (i % 20) * 10);
    expect(psi(a, b)).toBeLessThan(0.02);
  });

  it('large for a hard shift', () => {
    const a = Array.from({ length: 200 }, (_, i) => 100 + (i % 10));
    const b = Array.from({ length: 100 }, (_, i) => 500 + (i % 10));
    expect(psi(a, b)).toBeGreaterThan(1);
  });

  it('handles empty inputs', () => {
    expect(psi([], [1, 2])).toBe(0);
    expect(psi([1, 2], [])).toBe(0);
  });
});

describe('jsd', () => {
  it('0 for identical distributions, →1 for disjoint', () => {
    expect(jsd({ a: 5, b: 5 }, { a: 50, b: 50 })).toBeLessThan(0.001);
    expect(jsd({ a: 10 }, { b: 10 })).toBeGreaterThan(0.9);
    expect(jsd({}, { a: 1 })).toBe(0);
  });
});

describe('detectDrift', () => {
  it('refuses tiny cohorts (floors)', () => {
    const base = cohort(DRIFT_DEFAULTS.minBaselineSessions, baseFeatures);
    expect(detectDrift(base, cohort(2, baseFeatures)).status).toBe('insufficient-window');
    expect(detectDrift(cohort(5, baseFeatures), cohort(10, baseFeatures)).status).toBe('insufficient-baseline');
  });

  it('steady cohorts → ok with no findings', () => {
    const result = detectDrift(cohort(40, baseFeatures), cohort(10, baseFeatures));
    expect(result.status).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('a shifted numeric feature is found, scored, directed', () => {
    const base = cohort(40, baseFeatures);
    const window = cohort(10, (i) => ({ ...baseFeatures(i), errorRate: 0.5 + (i % 3) * 0.01 }));
    const result = detectDrift(base, window);
    expect(result.status).toBe('ok');
    const finding = result.findings.find((f) => f.feature === 'errorRate');
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe('numeric');
    expect(finding!.severity).toBe('major');
    expect(finding!.direction).toBe('up');
    expect(finding!.windowSummary).toBeGreaterThan(finding!.baselineSummary!);
  });

  it('a tool-mix swing is found as a mix finding', () => {
    const base = cohort(40, baseFeatures, { read: 8, bash: 2 });
    const window = cohort(10, baseFeatures, { read: 1, bash: 9 });
    const findings = detectDrift(base, window).findings;
    const mix = findings.find((f) => f.feature === 'toolMix');
    expect(mix).toBeDefined();
    expect(mix!.kind).toBe('mix');
  });

  it('a bigram (rhythm) swing is found even with the same mix', () => {
    const base = cohort(40, baseFeatures, { read: 5, bash: 5 }, { 'read>bash': 9, 'bash>read': 1 });
    const window = cohort(10, baseFeatures, { read: 5, bash: 5 }, { 'read>bash': 1, 'bash>read': 9 });
    const findings = detectDrift(base, window).findings;
    const bigram = findings.find((f) => f.feature === 'toolBigrams');
    expect(bigram).toBeDefined();
    expect(bigram!.kind).toBe('bigram');
  });

  it('findings sort by score, thresholds tune via options', () => {
    const base = cohort(40, baseFeatures);
    const window = cohort(10, (i) => ({ ...baseFeatures(i), errorRate: 0.5, medianGapMs: 8000 }));
    const result = detectDrift(base, window);
    const scores = result.findings.map((f) => f.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // Raising the moderate floor above every score silences detection.
    const silenced = detectDrift(base, window, { psiModerate: 99, jsdModerate: 99 });
    expect(silenced.findings).toEqual([]);
  });
});

describe('attributeFindings (D-003)', () => {
  const ledgerRow = (recordedAtMs: number, id = 'chg-1'): BehaviorChangeRow => ({
    id,
    workspaceId: 'ws-1',
    recordedAt: new Date(recordedAtMs).toISOString(),
    source: 'gym:accept',
    mutationClass: 'gym',
    action: 'set',
    targetKind: 'prompt-override',
    target: 'papercup/worker',
    harnessSlug: 'papercup',
    role: 'worker',
    diffRef: null,
    actor: 'gym',
    summary: 'champion accepted',
    payload: null,
  });
  const finding = {
    feature: 'errorRate',
    kind: 'numeric' as const,
    score: 0.4,
    severity: 'major' as const,
    baselineSummary: 0.05,
    windowSummary: 0.5,
    direction: 'up' as const,
  };

  it('a ledger row inside the lookback attributes the shift', () => {
    const [out] = attributeFindings([finding], [ledgerRow(T0 - 3600_000)], T0);
    expect(out.attributed).toBe(true);
    expect(out.ledgerCandidates).toHaveLength(1);
    expect(out.ledgerCandidates[0]).toMatchObject({ id: 'chg-1', source: 'gym:accept', target: 'papercup/worker' });
  });

  it('rows outside the lookback (too old or in the future) do not attribute', () => {
    const tooOld = ledgerRow(T0 - ATTRIBUTION_LOOKBACK_MS - 1);
    const future = ledgerRow(T0 + 60_000);
    const [out] = attributeFindings([finding], [tooOld, future], T0);
    expect(out.attributed).toBe(false);
    expect(out.ledgerCandidates).toEqual([]);
  });

  it('candidates rank newest first and cap at 5', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ledgerRow(T0 - (i + 1) * 60_000, `chg-${i}`));
    const [out] = attributeFindings([finding], rows, T0);
    expect(out.ledgerCandidates).toHaveLength(5);
    expect(out.ledgerCandidates[0].id).toBe('chg-0');
  });
});
