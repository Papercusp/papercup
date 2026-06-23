import { describe, it, expect, vi } from 'vitest';
import { applyHumanQueueRanking, humanQueueRankerSpec, HUMAN_QUEUE_FEATURES } from './human-queue';
import { buildDigest } from '../harness/improvements/digest';
import { rankHumanQueueByImpact } from '../harness/improvements/blocking-impact';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { IssueLinkCounts } from '../issues-engineer';

// OWNER_PREFERENCE_RANKING + DEFERRAL_INTEREST graduated to default-ON
// (flip-dark-flags-default-on-2026-06-23). These tests verify the blocking-impact-only ranker
// baseline, so pin the optional ranker-feature flags OFF explicitly (mirrors what every test here
// implicitly assumed while those flags were dark-by-default) rather than depend on the now-ON default.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));

const NOW = Date.parse('2026-06-12T12:00:00Z');
function daysAgo(n: number): string {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
}
function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'change', scope: 'operator', title: `distinct topic ${p.id}`, state: 'open', ...p };
}
function counts(m: Record<string, IssueLinkCounts>): Map<string, IssueLinkCounts> {
  return new Map(Object.entries(m));
}

/** A queue exercising every impact factor: links, recurrence, near-dups,
 *  watchdog persistence, severity, staleness. */
function richFixture() {
  const items: ImprovementCandidate[] = [
    cand({ id: 'EI-10', severity: 'minor', title: 'presence list overflows token limit', createdAt: daysAgo(20) }),
    cand({ id: 'EI-11', severity: 'minor', title: 'token limit overflows presence list', createdAt: daysAgo(1) }),
    cand({ id: 'EI-12', severity: 'critical', title: 'totally unrelated lone failure', createdAt: daysAgo(3) }),
    cand({ id: 'EI-13', severity: 'major', title: 'watchdog sees flaky webview boot', createdAt: daysAgo(8), watchdogKey: 'webview-boot:flaky' }),
    cand({ id: 'EI-14', severity: 'nit', title: 'rename a button label somewhere', createdAt: daysAgo(0) }),
  ];
  const linkCounts = counts({
    'EI-12': { blocksOut: 2, inboundRefs: 1 },
    'EI-14': { blocksOut: 0, inboundRefs: 4 },
  });
  return { items, linkCounts, digest: buildDigest(items, { nowMs: NOW }) };
}

describe('applyHumanQueueRanking — equivalence with B-08', () => {
  it('with blocking-impact as the sole feature, order AND scores are identical to rankHumanQueueByImpact', async () => {
    const { items, linkCounts, digest } = richFixture();
    const reference = rankHumanQueueByImpact(digest, { candidates: items, linkCounts });
    const ranked = await applyHumanQueueRanking(digest, { candidates: items, linkCounts });

    expect(ranked.humanQueue.map((i) => i.id)).toEqual(reference.map((i) => i.id));
    for (let i = 0; i < reference.length; i++) {
      expect(ranked.humanQueue[i].rank.score).toBe(reference[i].impact.score);
      expect(ranked.humanQueue[i].impact).toEqual(reference[i].impact);
    }
  });
});

describe('applyHumanQueueRanking — the one ranker pipeline', () => {
  it('every ranked item explains its score by named feature (weights inspectable)', async () => {
    const { items, linkCounts, digest } = richFixture();
    const ranked = await applyHumanQueueRanking(digest, { candidates: items, linkCounts });

    for (const item of ranked.humanQueue) {
      expect(item.rank.features.map((f) => f.feature)).toEqual(HUMAN_QUEUE_FEATURES.map((f) => f.name));
      const sum = item.rank.features.reduce((acc, f) => acc + f.contribution, 0);
      expect(item.rank.score).toBe(sum);
      const bi = item.rank.features.find((f) => f.feature === 'blocking-impact');
      expect(bi?.weight).toBe(1);
      expect(bi?.reasons).toEqual(item.impact.reasons);
      // The B-08 impact struct is attached for existing consumers.
      expect(typeof item.impact.score).toBe('number');
    }
  });

  it('fetches link counts through the injected reader and re-orders humanQueue only', async () => {
    const items: ImprovementCandidate[] = [
      cand({ id: 'EI-30', severity: 'minor', title: 'first lone topic alpha', createdAt: daysAgo(1) }),
      cand({ id: 'EI-31', severity: 'minor', title: 'second lone topic beta', createdAt: daysAgo(1) }),
    ];
    const digest = buildDigest(items, { nowMs: NOW });
    const readLinkCounts = vi.fn(async () => counts({ 'EI-31': { blocksOut: 5, inboundRefs: 0 } }));
    const ranked = await applyHumanQueueRanking(digest, { candidates: items }, { readLinkCounts });
    expect(readLinkCounts).toHaveBeenCalledWith(expect.arrayContaining(['EI-30', 'EI-31']));
    expect(ranked.humanQueue[0].id).toBe('EI-31');
    expect(ranked.headline).toBe(digest.headline); // everything else untouched
    expect(ranked.autoEligible).toEqual(digest.autoEligible);
  });

  it('degrades to link-free ranking when the link read fails (never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const items = [cand({ id: 'EI-40', severity: 'major', title: 'lone gamma topic', createdAt: daysAgo(1) })];
      const digest = buildDigest(items, { nowMs: NOW });
      const ranked = await applyHumanQueueRanking(
        digest,
        { candidates: items },
        { readLinkCounts: async () => Promise.reject(new Error('pg down')) },
      );
      expect(ranked.humanQueue[0].id).toBe('EI-40');
      expect(ranked.humanQueue[0].impact.blocksOut).toBe(0);
      expect(ranked.humanQueue[0].rank.score).toBe(ranked.humanQueue[0].impact.score);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('skips the link read entirely for an empty human queue', async () => {
    const digest = buildDigest([], { nowMs: NOW });
    const readLinkCounts = vi.fn(async () => new Map<string, IssueLinkCounts>());
    const ranked = await applyHumanQueueRanking(digest, {}, { readLinkCounts });
    expect(readLinkCounts).not.toHaveBeenCalled();
    expect(ranked.humanQueue).toEqual([]);
  });

  it('ties break on prior triage score then id (deterministic, B-08 rule)', async () => {
    // Two same-day, same-severity lone items — identical impact scores.
    const items: ImprovementCandidate[] = [
      cand({ id: 'EI-51', severity: 'minor', title: 'lone delta topic', createdAt: daysAgo(1) }),
      cand({ id: 'EI-50', severity: 'minor', title: 'lone epsilon topic', createdAt: daysAgo(1) }),
    ];
    const digest = buildDigest(items, { nowMs: NOW });
    const ranked = await applyHumanQueueRanking(digest, { candidates: items, linkCounts: new Map() });
    const [a, b] = ranked.humanQueue;
    expect(a.rank.score).toBe(b.rank.score);
    expect(ranked.humanQueue.map((i) => i.id)).toEqual(['EI-50', 'EI-51']);
  });
});

describe('humanQueueRankerSpec', () => {
  it('exposes the registry — names, weights, descriptions — as data', () => {
    const spec = humanQueueRankerSpec();
    expect(spec.length).toBe(HUMAN_QUEUE_FEATURES.length);
    expect(spec[0]).toEqual({
      name: 'blocking-impact',
      weight: 1,
      description: expect.stringContaining('B-08'),
    });
  });
});
