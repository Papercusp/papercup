import { describe, it, expect } from 'vitest';
import {
  projectFactRow,
  FACT_MARKER_FIELDS,
  type FoldedFact,
  type FactMarkerField,
} from './project-fact-row';

function fact(over: Partial<FoldedFact> = {}): FoldedFact {
  return {
    scope: 'workspace',
    scopeRef: null,
    key: 'k',
    body: 'b',
    createdBy: 'su-me',
    kind: null,
    settledBy: null,
    updatedAt: '2026-08-02T00:00:00Z',
    ...over,
  } as FoldedFact;
}

/**
 * The input that should cause each marker field to be emitted. This is the round-trip
 * fixture: every entry in FACT_MARKER_FIELDS must appear here, and must actually survive
 * the projection.
 */
const EMITTERS: Record<FactMarkerField, { input: Partial<FoldedFact>; changed?: boolean }> = {
  stale: { input: { sourceStale: { closed: true } } },
  dependsStale: { input: { depsStale: { moved: [] } as never } },
  contested: { input: { contested: { settledUndecidable: false, settledBy: null, priorAuthors: ['a', 'b'], priorVersions: 2, note: 'n' } } },
  kind: { input: { kind: 'conclusion' as never } },
  changed: { input: {}, changed: true },
  enforcement: { input: { kind: 'convention' as never, enforcement: { tier: 'gate' } as never } },
  cite: { input: { kind: 'convention' as never } },
  measurement: {
    input: { measurement: { subjectVolatile: true, measuredAt: '2026-08-11T20:50:00.000Z' } },
  },
};

describe('projectFactRow — marker round-trip completeness (EI-19390161700979033)', () => {
  // THE GUARD. The defect this file exists to stop is a marker that computes a field the
  // projection never emits — silent, and it has landed three times (P-033 e, P-018,
  // WI-7236). Add a marker to FACT_MARKER_FIELDS without projecting it and this fails.
  it('every declared marker field has an emitting fixture', () => {
    for (const field of FACT_MARKER_FIELDS) {
      expect(EMITTERS[field], `FACT_MARKER_FIELDS lists "${field}" but no fixture emits it`).toBeDefined();
    }
    expect(Object.keys(EMITTERS).sort()).toEqual([...FACT_MARKER_FIELDS].sort());
  });

  it.each([...FACT_MARKER_FIELDS])('projects %s when the marker is present', (field) => {
    const { input, changed } = EMITTERS[field];
    const row = projectFactRow(fact(input), { changed });
    expect(
      row[field],
      `marker "${field}" was set on the fact but did NOT survive projectFactRow — ` +
        'this is the silent-drop defect the module header describes',
    ).toBeDefined();
  });

  it('emits NO marker field for a plain fact — an ordinary fold stays byte-identical', () => {
    const row = projectFactRow(fact());
    for (const field of FACT_MARKER_FIELDS) expect(row[field]).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(['body', 'ref', 'scope', 'src']);
  });
});

describe('projectFactRow — base fields + emission rules', () => {
  it('always carries scope/ref/body/src', () => {
    const row = projectFactRow(fact({ scope: 'harness', scopeRef: 'papercusp', body: 'hello' }));
    expect(row).toMatchObject({ scope: 'harness', ref: 'papercusp', body: 'hello' });
    expect(row).toHaveProperty('src');
  });

  it('emits aud only when the fact is audience-scoped', () => {
    expect(projectFactRow(fact()).aud).toBeUndefined();
    expect(projectFactRow(fact({ audienceScope: 'fleet:x' })).aud).toBe('fleet:x');
  });

  it('changed is driven by the CALLER watermark, not by the fact', () => {
    // P-008 (c) / D-012: two callers see different `changed` for the very same fact.
    const f = fact();
    expect(projectFactRow(f, { changed: true }).changed).toBe(true);
    expect(projectFactRow(f, { changed: false }).changed).toBeUndefined();
    expect(projectFactRow(f).changed).toBeUndefined();
  });

  it('cite is emitted for a convention and withheld otherwise', () => {
    // Without it the fold could name a convention it gave you no way to cite (D-075 R1).
    expect(projectFactRow(fact({ kind: 'convention' as never })).cite).toBeDefined();
    expect(projectFactRow(fact({ kind: 'conclusion' as never })).cite).toBeUndefined();
  });

  it('enforcement rides only with a convention, never on a bare conclusion', () => {
    const asConclusion = projectFactRow(
      fact({ kind: 'conclusion' as never, enforcement: { tier: 'gate' } as never }),
    );
    expect(asConclusion.enforcement).toBeUndefined();
  });

  it('stale and dependsStale stay DISTINCT — a hint is not a mechanical verdict', () => {
    const row = projectFactRow(fact({ sourceStale: { closed: true }, depsStale: { moved: [] } as never }));
    expect(row.stale).toBeDefined();
    expect(row.dependsStale).toBeDefined();
  });
});
