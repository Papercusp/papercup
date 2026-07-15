/** insight-docs-matcher (ambient-semantic-push P-010): matcher 4 — insight/
 *  runbook suggestions. Verifies the info-severity (drone-invisible) push, the
 *  conservative floor + cap, ordering, and purity. The P-010 shipping gate is a
 *  live concern; this only proves the pure core. */
import { describe, it, expect } from 'vitest';
import { buildCursor } from './lexical-cursor';
import { selectPushes, type KnownContext } from './ambient-push';
import { matchInsightDocs, DEFAULT_INSIGHT_MIN_SCORE, DEFAULT_INSIGHT_MAX_DOCS, type InsightDoc } from './insight-docs-matcher';

const WORK_NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

describe('matchInsightDocs — fires on cursor↔doc overlap', () => {
  it('emits an info insight push with a doc handle and shared terms', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const doc: InsightDoc = { ref: 'agent-insights/psu-launcher-restart-loop.mdx', text: WORK_NOTE };
    const [m, ...rest] = matchInsightDocs(cursor, [doc]);
    expect(rest).toHaveLength(0);
    expect(m.push.matcherKind).toBe('insight');
    expect(m.push.severity).toBe('info'); // drone-invisible by D-004 policy
    expect(m.push.provenance).toBe('data-not-directive');
    expect(m.push.handle.kind).toBe('doc');
    expect(m.push.handle.ref).toBe('agent-insights/psu-launcher-restart-loop.mdx');
    expect(m.push.handle.query).toContain('WI-4790');
    expect(m.push.teaser).toContain('runbook');
  });

  it('stays silent on a disjoint doc and below the floor', () => {
    const cursor = buildCursor([WORK_NOTE]);
    expect(matchInsightDocs(cursor, [{ ref: 'd', text: 'quarterly mac vm sudo password rotation' }])).toEqual([]);
    // Weak single-term overlap: read the raw score, then gate just above it.
    const weak: InsightDoc = { ref: 'w', text: 'nightly compaction of cold storage archives offsite elsewhere' };
    const raw = matchInsightDocs(cursor, [weak], { minScore: 0 });
    expect(raw).toHaveLength(1);
    expect(matchInsightDocs(cursor, [weak], { minScore: raw[0].overlap.score + 0.01 })).toEqual([]);
  });

  it('is the most conservative matcher: floor above dead-end (0.3), cap 3, and caps output', () => {
    expect(DEFAULT_INSIGHT_MIN_SCORE).toBeGreaterThan(0.3);
    expect(DEFAULT_INSIGHT_MAX_DOCS).toBe(3);
    const cursor = buildCursor([WORK_NOTE]);
    const docs: InsightDoc[] = [1, 2, 3, 4, 5].map((n) => ({ ref: `doc-${n}`, text: WORK_NOTE }));
    expect(matchInsightDocs(cursor, docs)).toHaveLength(3);
  });

  it('orders strongest-first with a deterministic ref tie-break; skips empty docs; pure', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const docs: InsightDoc[] = [
      { ref: 'b-same', text: WORK_NOTE },
      { ref: 'a-same', text: WORK_NOTE },
      { ref: 'weak', text: 'compaction of unrelated cold archives elsewhere entirely' },
      { ref: '', text: WORK_NOTE },
      { ref: 'blank', text: '   ' },
    ];
    const snapshot = JSON.parse(JSON.stringify(docs));
    const refs = matchInsightDocs(cursor, docs, { minScore: 0 }).map((m) => m.doc.ref);
    expect(refs.slice(0, 2)).toEqual(['a-same', 'b-same']);
    expect(refs).not.toContain('');
    expect(refs).not.toContain('blank');
    expect(docs).toEqual(snapshot);
  });

  it('composes with selectPushes: info is severity-gated OFF a drone, delivered to interactive', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const matches = matchInsightDocs(cursor, [{ ref: 'doc-1', text: WORK_NOTE }]);
    const known: KnownContext = { refs: new Set() };
    const drone = selectPushes({ candidates: matches.map((m) => m.push), sessionClass: 'drone', known });
    expect(drone.selected).toHaveLength(0);
    expect(drone.dropped[0].reason).toBe('severity-gated');
    const interactive = selectPushes({ candidates: matches.map((m) => m.push), sessionClass: 'interactive', known });
    expect(interactive.selected).toHaveLength(1);
  });
});
