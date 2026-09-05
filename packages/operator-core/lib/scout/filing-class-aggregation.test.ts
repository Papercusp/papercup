import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FILING_CLASS_MIN_MEMBERS,
  buildFilingClassItemDraft,
  summarizeFilingClasses,
  type FilingClassMemberLike,
} from './filing-class-aggregation';

const member = (over: Partial<FilingClassMemberLike> & { workItemId: string; toolName: string }): FilingClassMemberLike => ({
  origin: 'agent-review',
  routedAtMs: Date.parse('2026-09-01T00:00:00Z'),
  ...over,
});

/** The shape measured on the live table 2026-09-05: a concentrated head plus a long tail. */
const corpus = (): FilingClassMemberLike[] => [
  ...Array.from({ length: 5 }, (_, i) =>
    member({
      workItemId: `EI-send-${i}`,
      toolName: 'coord:send',
      errorCode: i % 2 === 0 ? 'invalid_input' : 'invalid_args',
      fieldPath: 'summary',
      routedAtMs: Date.parse('2026-09-01T00:00:00Z') + i * 1000,
    }),
  ),
  ...Array.from({ length: 3 }, (_, i) =>
    member({ workItemId: `EI-complete-${i}`, toolName: 'work_items:complete', errorCode: 'verification_coverage' }),
  ),
  member({ workItemId: 'EI-solo-1', toolName: 'plans:list' }),
  member({ workItemId: 'EI-solo-2', toolName: 'docs:search' }),
];

describe('summarizeFilingClasses', () => {
  it('groups on the structured toolName and ranks the concentrated head first', () => {
    const census = summarizeFilingClasses(corpus());
    expect(census.classes.map((c) => [c.toolName, c.memberCount])).toEqual([
      ['coord:send', 5],
      ['work_items:complete', 3],
    ]);
    expect(census.classes[0].memberIds).toEqual([
      'EI-send-0',
      'EI-send-1',
      'EI-send-2',
      'EI-send-3',
      'EI-send-4',
    ]);
  });

  it('accounts for every member it saw: classed + unclassed === total', () => {
    const census = summarizeFilingClasses(corpus());
    expect(census.totalMembers).toBe(10);
    expect(census.classedMembers).toBe(8);
    expect(census.unclassedMembers).toBe(2);
    expect(census.classedMembers + census.unclassedMembers).toBe(census.totalMembers);
    expect(census.distinctSurfaces).toBe(4);
    expect(census.classedSurfaces).toBe(2);
    expect(census.minMembers).toBe(FILING_CLASS_MIN_MEMBERS);
  });

  it('honours an explicit threshold — a lower floor promotes the tail', () => {
    const census = summarizeFilingClasses(corpus(), { minMembers: 1 });
    expect(census.classedSurfaces).toBe(4);
    expect(census.unclassedMembers).toBe(0);
  });

  it('never folds an unnamed surface into a "" class', () => {
    const census = summarizeFilingClasses([
      ...corpus(),
      member({ workItemId: 'EI-blank-1', toolName: '   ' }),
      member({ workItemId: 'EI-blank-2', toolName: '' }),
    ]);
    expect(census.totalMembers).toBe(10);
    expect(census.classes.map((c) => c.toolName)).not.toContain('');
  });

  it('reports counts per producer origin so a class is never rendered origin-blind', () => {
    const census = summarizeFilingClasses([
      ...Array.from({ length: 3 }, (_, i) => member({ workItemId: `EI-a-${i}`, toolName: 'coord:inbox' })),
      member({ workItemId: 'EI-b-1', toolName: 'coord:inbox', origin: 'su-ideate' }),
    ]);
    expect(census.classes[0].byOrigin).toEqual({ 'agent-review': 3, 'su-ideate': 1 });
  });

  it('bounds the cited id list without ever understating memberCount', () => {
    const many = Array.from({ length: 9 }, (_, i) => member({ workItemId: `EI-x-${i}`, toolName: 'coord:send' }));
    const census = summarizeFilingClasses(many, { memberIdCap: 4 });
    expect(census.classes[0].memberCount).toBe(9);
    expect(census.classes[0].memberIds).toHaveLength(4);
    expect(census.classes[0].memberIdsTruncated).toBe(true);
  });

  it('limit cuts the rendered list but not the reported population', () => {
    const census = summarizeFilingClasses(corpus(), { limit: 1 });
    expect(census.classes).toHaveLength(1);
    expect(census.classedSurfaces).toBe(2);
    expect(census.classesTruncated).toBe(true);
  });
});

describe('buildFilingClassItemDraft — D-001: aggregation is ADDITIVE', () => {
  const draftForHead = () => {
    const census = summarizeFilingClasses(corpus());
    return buildFilingClassItemDraft(census.classes[0], { nowMs: Date.parse('2026-09-05T20:00:00Z') });
  };

  it('cites every member by id and emits only non-destructive relates edges', () => {
    const draft = draftForHead();
    expect(draft.links).toHaveLength(5);
    expect(new Set(draft.links.map((l) => l.rel))).toEqual(new Set(['relates']));
    expect(draft.links.map((l) => l.targetId)).toEqual(draft.payload.filingClass.memberIds);
    for (const id of draft.payload.filingClass.memberIds) expect(draft.body).toContain(id);
  });

  it('carries a machine-readable class identity so a re-run recognises the row', () => {
    const draft = draftForHead();
    expect(draft.payload.filingClass.toolName).toBe('coord:send');
    expect(draft.payload.filingClass.memberCount).toBe(5);
    expect(draft.title).toContain('coord:send');
  });

  /**
   * RECURRENCE GUARD for D-001. The decision forbids a class row that REPLACES its
   * members — silent merge, bulk close, or de-duplication that drops member rows. A unit
   * test over the draft cannot catch that arriving later as a new function beside it, so
   * this pins the whole module's SOURCE: no destructive statement against the member
   * population, and no `duplicates` edge (the rel a de-duplicator would need).
   */
  it('the module contains no path that mutates, closes or merges a member row', () => {
    // Scan CODE, not prose: the module's own doc comments NAME the forbidden shapes in
    // order to forbid them, and a guard that trips on its own rationale teaches nothing.
    const src = readFileSync(path.join(__dirname, 'filing-class-aggregation.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const forbidden: Array<[string, RegExp]> = [
      ['an UPDATE against the filing population', /\bUPDATE\s+harness_shared\./i],
      ['a DELETE against the filing population', /\bDELETE\s+FROM\s+harness_shared\./i],
      ['a duplicates edge (licenses closing members)', /['"`]duplicates['"`]/],
      ['a member close/resolve write', /\b(closeWorkItem|resolveWorkItem|bulkClose|mergeWorkItems)\b/],
    ];
    // POSITIVE CONTROL first: a guard that cannot fire is indistinguishable from a clean
    // module, and that reading is exactly what this test exists to prevent.
    const destructiveSample = [
      "await sql`UPDATE harness_shared.work_items SET status = 'done'`;",
      "await sql`DELETE FROM harness_shared.scout_routed_ideas`;",
      "links.push({ rel: 'duplicates', targetId });",
      'await closeWorkItem(memberId);',
    ].join('\n');
    for (const [what, re] of forbidden) {
      expect({ what, firesOnDestructiveCode: re.test(destructiveSample) }).toEqual({
        what,
        firesOnDestructiveCode: true,
      });
    }
    for (const [what, re] of forbidden) {
      expect({ what, found: re.test(src) }).toEqual({ what, found: false });
    }
  });
});
