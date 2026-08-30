/**
 * acceptance-grading-authority.test.ts — P-004 of
 * unified-responder-selection-critique-and-grading-2026-08-30.
 *
 * Subject: the rule that a below-floor MINIMUM-FILL grading card may not
 * supersede an above-floor one under the acceptance gate's latest-wins pick,
 * plus the two ways that rule is allowed to be wrong in the SAFE direction
 * (unknown provenance ranks as floor; a failed row read ranks everything as
 * floor). The gate's own wiring is exercised in plan-acceptance-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import type { SelectionVia } from '@papercusp/ranked-selection';
import {
  compareGradingAuthority,
  graderSelectionVia,
  gradingViaOf,
  pickAuthoritativeGrading,
  readGraderSelectionVia,
  GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS,
} from './acceptance-grading-authority';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
const mockPg = vi.mocked(getOrgPg);

/** A routing snapshot as `prodOpenGradingCascade` persists it. */
const routingWith = (selected: Array<{ ownerId: unknown; via: unknown }>) => ({
  cascade: { flavor: 'acceptance-grading', rubricId: 'ar-plan' },
  selection: { min: 1, max: 2, selected },
});

const card = (createdBy: string | null, createdAt: string) => ({ createdBy, createdAt });

describe('graderSelectionVia — folding the durable rows into ownerId → via', () => {
  it('reads ownerId/via off routing.selection.selected', () => {
    const map = graderSelectionVia([
      routingWith([
        { ownerId: 'su-a', via: 'floor' },
        { ownerId: 'su-b', via: 'minimum' },
      ]),
    ]);
    expect(map.get('su-a')).toBe('floor');
    expect(map.get('su-b')).toBe('minimum');
  });

  it('ignores rows with no selection block at all (a pre-min/max or non-selecting route)', () => {
    expect(graderSelectionVia([null, undefined, {}, { selection: {} }, { selection: { selected: 'nope' } }]).size).toBe(
      0,
    );
  });

  it('skips malformed entries rather than inventing a label for them', () => {
    const map = graderSelectionVia([
      routingWith([
        { ownerId: 42, via: 'minimum' },
        { ownerId: '', via: 'minimum' },
        { ownerId: 'su-c', via: null },
        // A future third `via` must be ranked deliberately in the library, not
        // silently folded into one of today's two here.
        { ownerId: 'su-d', via: 'some-future-via' },
      ]),
    ]);
    expect(map.size).toBe(0);
  });

  it('resolves a grader appearing in two rounds UPWARD — floor wins over minimum, in either order', () => {
    const floorFirst = graderSelectionVia([
      routingWith([{ ownerId: 'su-a', via: 'floor' }]),
      routingWith([{ ownerId: 'su-a', via: 'minimum' }]),
    ]);
    const minimumFirst = graderSelectionVia([
      routingWith([{ ownerId: 'su-a', via: 'minimum' }]),
      routingWith([{ ownerId: 'su-a', via: 'floor' }]),
    ]);
    expect(floorFirst.get('su-a')).toBe('floor');
    expect(minimumFirst.get('su-a')).toBe('floor');
  });
});

describe('pickAuthoritativeGrading — authority first, recency as the tie-break', () => {
  const viaMap = (entries: Record<string, SelectionVia>) => new Map(Object.entries(entries));
  const viaOf = (m: Map<string, SelectionVia>) => (c: { createdBy: string | null }) => gradingViaOf(c, m);

  it('a LATER minimum-fill card does not supersede an earlier floor card (the P-004 rule)', () => {
    const floor = card('su-floor', '2026-08-30T01:00:00Z');
    const minimum = card('su-min', '2026-08-30T09:00:00Z');
    const picked = pickAuthoritativeGrading(
      [floor, minimum],
      viaOf(viaMap({ 'su-floor': 'floor', 'su-min': 'minimum' })),
    );
    expect(picked).toBe(floor);
  });

  it('CONTROL (falsifiability, in-test — no tree mutation): relabel the SAME pair floor/floor and recency decides', () => {
    // If the pick were still plain latest-wins, the case above would already
    // return `minimum`; this control proves the earlier card wins there because
    // of its LABEL and not because of anything else about the fixture.
    const earlier = card('su-floor', '2026-08-30T01:00:00Z');
    const later = card('su-min', '2026-08-30T09:00:00Z');
    const picked = pickAuthoritativeGrading(
      [earlier, later],
      viaOf(viaMap({ 'su-floor': 'floor', 'su-min': 'floor' })),
    );
    expect(picked).toBe(later);
  });

  it('between two equally-qualified graders the LATEST still wins — D-003 carry makes it the best-informed one', () => {
    const first = card('su-a', '2026-08-30T01:00:00Z');
    const second = card('su-b', '2026-08-30T09:00:00Z');
    expect(pickAuthoritativeGrading([first, second], viaOf(viaMap({ 'su-a': 'floor', 'su-b': 'floor' })))).toBe(second);
  });

  it('between two minimum-fills the latest wins — the rule demotes, it does not deadlock', () => {
    const first = card('su-a', '2026-08-30T01:00:00Z');
    const second = card('su-b', '2026-08-30T09:00:00Z');
    expect(pickAuthoritativeGrading([first, second], viaOf(viaMap({ 'su-a': 'minimum', 'su-b': 'minimum' })))).toBe(
      second,
    );
  });

  it('an UNLABELLED card ranks as floor — an owner-filed or pre-cascade grading is never demoted', () => {
    const unlabelled = card('su-owner', '2026-08-30T01:00:00Z');
    const minimum = card('su-min', '2026-08-30T09:00:00Z');
    expect(pickAuthoritativeGrading([unlabelled, minimum], viaOf(viaMap({ 'su-min': 'minimum' })))).toBe(unlabelled);
  });

  it('a null createdBy is unattributable, therefore unlabelled, therefore not demoted', () => {
    expect(gradingViaOf(card(null, '2026-08-30T01:00:00Z'), viaMap({ 'su-min': 'minimum' }))).toBeNull();
  });

  it('returns undefined for an empty list, mirroring the [0] it replaces', () => {
    expect(pickAuthoritativeGrading([], () => null)).toBeUndefined();
  });

  it('the comparator is a total order over the mixed set (sorts, never throws on ties)', () => {
    const cards = [
      card('su-min-late', '2026-08-30T09:00:00Z'),
      card('su-floor-early', '2026-08-30T01:00:00Z'),
      card('su-unknown', '2026-08-30T02:00:00Z'),
      card('su-min-early', '2026-08-30T00:00:00Z'),
    ];
    const sorted = cards
      .slice()
      .sort(
        compareGradingAuthority(viaOf(viaMap({ 'su-min-late': 'minimum', 'su-floor-early': 'floor', 'su-min-early': 'minimum' }))),
      );
    expect(sorted.map((c) => c.createdBy)).toEqual(['su-unknown', 'su-floor-early', 'su-min-late', 'su-min-early']);
  });
});

describe('readGraderSelectionVia — the durable read', () => {
  beforeEach(() => vi.resetAllMocks());

  /** Capture the query text alongside the rows it answers with. */
  const sqlSpy = (rows: unknown[]) => {
    const seen: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      seen.push(strings.raw.join(' '));
      return Promise.resolve(rows);
    }) as unknown as ReturnType<typeof getOrgPg>['sql'];
    mockPg.mockReturnValue({ sql } as ReturnType<typeof getOrgPg>);
    return seen;
  };

  it('folds the routing column of every returned row', async () => {
    sqlSpy([
      { routing: routingWith([{ ownerId: 'su-a', via: 'floor' }]) },
      { routing: routingWith([{ ownerId: 'su-b', via: 'minimum' }]) },
    ]);
    const map = await readGraderSelectionVia('ws', 'ar-plan');
    expect([...map]).toEqual([
      ['su-a', 'floor'],
      ['su-b', 'minimum'],
    ]);
  });

  it('does NOT filter on closed_at — the gate runs after the cascade has closed', async () => {
    // The regression this guards is silent in both directions: copying the
    // liveness predicate from acceptance-grader.ts's two readers would empty
    // the map in the COMMON case, and because unknown ranks as floor the gate
    // would quietly revert to the pre-P-004 latest-wins with nothing red.
    const seen = sqlSpy([]);
    await readGraderSelectionVia('ws', 'ar-plan');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('harness_shared.consult_state');
    expect(seen[0]).not.toContain('closed_at');
  });

  it('bounds the lookback rather than scanning every round a rubric ever had', async () => {
    const seen = sqlSpy([]);
    await readGraderSelectionVia('ws', 'ar-plan');
    expect(seen[0]).toContain('LIMIT');
    expect(GRADING_CASCADE_AUTHORITY_LOOKBACK_ROWS).toBeGreaterThan(1);
  });

  it('fails SOFT to an empty map — a database fault must not refuse every ship in the workspace', async () => {
    mockPg.mockImplementation(() => {
      throw new Error('pool exhausted');
    });
    await expect(readGraderSelectionVia('ws', 'ar-plan')).resolves.toEqual(new Map());
  });

  it('fails soft on a rejected query too, not only a thrown connection', async () => {
    const sql = (() => Promise.reject(new Error('timeout'))) as unknown as ReturnType<typeof getOrgPg>['sql'];
    mockPg.mockReturnValue({ sql } as ReturnType<typeof getOrgPg>);
    await expect(readGraderSelectionVia('ws', 'ar-plan')).resolves.toEqual(new Map());
  });
});
