import { describe, it, expect } from 'vitest';
import {
  BLOCKING_IMPACT_WEIGHTS,
  computeBlockingImpact,
  rankHumanQueueByImpact,
  stalenessMultiplier,
} from './blocking-impact';
import { buildDigest } from './digest';
import type { ScoredItem } from './digest';
import type { ImprovementCandidate } from './policy';
import type { IssueLinkCounts } from '../../issues-engineer';

const NOW = Date.parse('2026-06-12T12:00:00Z');
function daysAgo(n: number): string {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
}
function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'change', scope: 'operator', title: `distinct topic ${p.id}`, state: 'open', ...p };
}
function item(p: Partial<ScoredItem> & { id: string }): ScoredItem {
  return {
    kind: 'change',
    title: `distinct topic ${p.id}`,
    scope: 'operator',
    tier: 'human',
    score: 10,
    ageDays: 0,
    tierReason: 'test',
    ...p,
  };
}
function counts(m: Record<string, IssueLinkCounts>): Map<string, IssueLinkCounts> {
  return new Map(Object.entries(m));
}

describe('stalenessMultiplier (EI-352 log curve)', () => {
  it('is 1.0 fresh and grows logarithmically, capped', () => {
    expect(stalenessMultiplier(0)).toBe(1);
    expect(stalenessMultiplier(7)).toBeCloseTo(1 + Math.log10(8), 5);
    expect(stalenessMultiplier(999)).toBe(stalenessMultiplier(BLOCKING_IMPACT_WEIGHTS.stalenessCapDays));
  });
});

describe('computeBlockingImpact', () => {
  it('with no context degrades to the severity prior × staleness', () => {
    const impact = computeBlockingImpact(item({ id: 'EI-1', severity: 'minor', ageDays: 0 }));
    expect(impact.score).toBe(BLOCKING_IMPACT_WEIGHTS.severity.minor);
    expect(impact.blocksOut).toBe(0);
    expect(impact.reasons).toEqual([]);
  });

  it('weights outbound blocks edges highest and explains them', () => {
    const impact = computeBlockingImpact(item({ id: 'EI-2', severity: 'minor', ageDays: 0 }), {
      linkCounts: counts({ 'EI-2': { blocksOut: 3, inboundRefs: 2 } }),
    });
    expect(impact.blocksOut).toBe(3);
    expect(impact.inboundRefs).toBe(2);
    expect(impact.score).toBe(
      BLOCKING_IMPACT_WEIGHTS.blocksOut * 3 +
        BLOCKING_IMPACT_WEIGHTS.inboundRef * 2 +
        BLOCKING_IMPACT_WEIGHTS.severity.minor,
    );
    expect(impact.reasons).toContain('blocks 3 downstream item(s)');
    expect(impact.reasons).toContain('2 inbound reference(s)');
  });

  it('counts open recurrence excluding the item itself, and dup peers beyond the signature group', () => {
    const impact = computeBlockingImpact(item({ id: 'EI-3', severity: 'minor', ageDays: 0 }), {
      // Signature seen 3× (this open item + 1 other open + 1 resolved); the
      // near-dup cluster adds one more member beyond the exact group.
      recurrence: { signature: 's', count: 3, openCount: 2, resolvedCount: 1, ids: ['EI-3', 'x', 'y'], lastSeenMs: NOW, decayDays: 0 },
      dupClusterSize: 4,
    });
    expect(impact.openRecurrence).toBe(1);
    expect(impact.resolvedRecurrence).toBe(1);
    expect(impact.dupPeers).toBe(1); // 4 members − self − 2 exact peers
    expect(impact.reasons).toContain('1 open re-capture(s) of the same friction');
  });

  it('flags an open watchdog signal only when the candidate carries a watchdogKey and is open', () => {
    const open = computeBlockingImpact(item({ id: 'EI-4', ageDays: 0 }), {
      candidates: [cand({ id: 'EI-4', watchdogKey: 'service-down:shop' })],
    });
    expect(open.watchdogActive).toBe(true);
    expect(open.reasons).toContain('open watchdog signal (objective, recurring)');

    const noKey = computeBlockingImpact(item({ id: 'EI-5', ageDays: 0 }), { candidates: [cand({ id: 'EI-5' })] });
    expect(noKey.watchdogActive).toBe(false);

    const resolved = computeBlockingImpact(item({ id: 'EI-6', state: 'resolved', ageDays: 0 }), {
      candidates: [cand({ id: 'EI-6', state: 'resolved', watchdogKey: 'service-down:shop' })],
    });
    expect(resolved.watchdogActive).toBe(false);
  });

  it('staleness self-promotes an unattended item (EI-340)', () => {
    const fresh = computeBlockingImpact(item({ id: 'EI-7', severity: 'major', ageDays: 0 }));
    const stale = computeBlockingImpact(item({ id: 'EI-7', severity: 'major', ageDays: 14 }));
    expect(stale.score).toBeGreaterThan(fresh.score);
    expect(stale.reasons.some((r) => r.startsWith('unattended 14d'))).toBe(true);
  });
});

describe('rankHumanQueueByImpact', () => {
  it('orders the human queue by impact desc and maps digest recurrence/dup context', () => {
    const items: ImprovementCandidate[] = [
      // Recurring open friction (same signature twice) — should outrank the lone critical below
      // once link degree is attached to the first.
      cand({ id: 'EI-10', severity: 'minor', title: 'presence list overflows token limit', createdAt: daysAgo(2) }),
      cand({ id: 'EI-11', severity: 'minor', title: 'token limit overflows presence list', createdAt: daysAgo(1) }),
      cand({ id: 'EI-12', severity: 'critical', title: 'totally unrelated lone failure', createdAt: daysAgo(1) }),
    ];
    const digest = buildDigest(items, { nowMs: NOW });
    expect(digest.humanQueue.map((i) => i.id).sort()).toEqual(['EI-10', 'EI-11', 'EI-12']);

    const ranked = rankHumanQueueByImpact(digest, {
      candidates: items,
      linkCounts: counts({ 'EI-10': { blocksOut: 2, inboundRefs: 0 } }),
    });
    expect(ranked[0].id).toBe('EI-10'); // 2 blocks edges + recurrence beat the lone critical
    expect(ranked[0].impact.blocksOut).toBe(2);
    expect(ranked[0].impact.openRecurrence).toBe(1);
    expect(ranked.every((r) => typeof r.impact.score === 'number')).toBe(true);
    // Every original field survives (additive enrichment).
    expect(ranked[0].title).toBe('presence list overflows token limit');
  });

  it('breaks impact ties deterministically (triage score, then id)', () => {
    const digest = {
      humanQueue: [item({ id: 'EI-21', score: 5 }), item({ id: 'EI-20', score: 5 })],
      recurringSignatures: [],
      likelyDuplicates: [],
    };
    const ranked = rankHumanQueueByImpact(digest);
    expect(ranked.map((r) => r.id)).toEqual(['EI-20', 'EI-21']);
  });
});
