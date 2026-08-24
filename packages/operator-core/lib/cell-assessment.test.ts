/**
 * P-003 / D-008 — the ASSESSMENT contract: what a cell's raw value MEANS, and what is
 * safe to do about it.
 *
 * The centre of gravity of this suite is ONE invariant, which is the whole reason the
 * assessment replaces the falsifier rather than sitting beside it:
 *
 *   GENERIC CODE MAY TRANSPORT A DOMAIN CODE. IT MAY NEVER INVENT ONE.
 *
 * Every way of failing — a path that never arrived, a non-string, a code the spec does
 * not declare, evidence that went missing, a door-truncated payload — must converge on
 * `unavailable`. A plausible enum nobody measured is worse than an honest refusal,
 * because it arrives wearing the contract's badge; that is the exact failure D-038 was
 * written about one field over, and the reason `falsifier` is being retired rather
 * than merely renamed.
 *
 * ⚠ ON THE CONTROLS AT THE BOTTOM OF THIS FILE. A guard test that has never failed is
 * a guard nobody has tested. This repo's falsifiability rule forbids proving that by
 * mutating the shared tree, and prescribes the tier used here for imported logic: keep
 * a deliberately-WRONG implementation permanently in the test file, assert the real
 * assertions reject it, and pair it with a CALIBRATION case the real subject must pass
 * — because controls that pass when the property itself is broken prove nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    // Only the DISPATCH is faked. Every projection under test — the path walk, the
    // code lookup, the evidence resolution — is the real one, so a regression in any
    // of them reds this suite instead of passing on a fixture.
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { readCell } from './cell-read';
import {
  CELL_UNKNOWN_CODES,
  registerCell,
  validateCellSpec,
  __resetCellRegistryForTests,
  type CellAssessmentSpec,
  type CellSpec,
} from './cell-registry';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };

/** A well-formed assessment, so a test that is about ONE rule does not trip another. */
function assessment(over: Partial<CellAssessmentSpec> = {}): CellAssessmentSpec {
  return {
    path: 'assessments.deployedSha',
    codes: {
      serving: { meaning: 'The running process is executing this sha.', safeAction: 'Treat the deploy as live.' },
      stale: {
        meaning: 'The sha is deployed on disk but the process predates it.',
        safeAction: 'Restart the unit before trusting the deploy.',
      },
    },
    evidence: ['serving.startedSinceCodeChange'],
    ...over,
  };
}

/** A registrable spec — every OTHER axis satisfied, for the same isolation reason. */
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'positions.deployed',
    // P-006/D-016 — a POLL cell, so a real assessment is REQUIRED. Tests that are about
    // the assessment itself override it; tests that are not get a valid one so the
    // registry never refuses for a reason unrelated to what they assert.
    assessment: assessment(),
    nullable: false,
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

/** The rules this suite raised, so a test asserts on the RULE and not on prose. */
function rulesFor(s: CellSpec): string[] {
  return validateCellSpec(s)
    .filter((r) => r.axis === 'assessment')
    .map((r) => r.rule);
}

/** A payload that satisfies the default spec + assessment above. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    positions: { deployed: true },
    serving: { startedSinceCodeChange: true },
    assessments: { deployedSha: 'serving' },
    ...over,
  };
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('registry — the assessment declaration is validated, not trusted', () => {
  it('CALIBRATION: a well-formed assessment raises nothing', () => {
    // Without this, every rejection test below would still pass against a validator
    // that rejected EVERYTHING — the classic control that proves nothing.
    expect(rulesFor(spec({ assessment: assessment() }))).toEqual([]);
  });

  it('ADDITIVITY: a cell that declares no assessment raises nothing', () => {
    // P-003 is additive: the ten unmigrated cells must register exactly as before.
    // If this ever reds, the migration has become a breaking change by accident.
    expect(rulesFor(spec())).toEqual([]);
  });

  it('rejects a missing assessment path', () => {
    expect(rulesFor(spec({ assessment: assessment({ path: '  ' }) }))).toContain('assessment-path-missing');
  });

  it('rejects an assessment that IS the headline', () => {
    expect(rulesFor(spec({ assessment: assessment({ path: 'positions.deployed' }) }))).toContain(
      'assessment-is-headline',
    );
  });

  it('rejects an assessment that is the headline merely re-punctuated', () => {
    // `norm` is deliberate here: a re-cased restatement of the headline is exactly the
    // emptiness this rule exists to catch, so an exact-match check would miss it.
    expect(rulesFor(spec({ assessment: assessment({ path: 'Positions_Deployed' }) }))).toContain(
      'assessment-is-headline',
    );
  });

  it('rejects an assessment on an event-signalled cell — there is no resolver payload to read', () => {
    const s = spec({
      assessment: assessment(),
      changeSignal: { kind: 'event', key: 'gate:green' },
    });
    expect(rulesFor(s)).toContain('assessment-on-event-cell');
  });

  it('rejects an empty code map — it could never resolve', () => {
    expect(rulesFor(spec({ assessment: assessment({ codes: {} }) }))).toContain('assessment-codes-empty');
  });

  it('rejects a code whose meaning or safeAction is missing', () => {
    const s = spec({
      assessment: assessment({ codes: { serving: { meaning: 'live', safeAction: '  ' } } }),
    });
    expect(rulesFor(s)).toContain('assessment-code-incomplete');
  });

  it('rejects two spellings of one code', () => {
    const s = spec({
      assessment: assessment({
        codes: {
          'is-serving': { meaning: 'a', safeAction: 'b' },
          isServing: { meaning: 'c', safeAction: 'd' },
        },
      }),
    });
    expect(rulesFor(s)).toContain('assessment-code-duplicate');
  });

  it.each(CELL_UNKNOWN_CODES)('rejects "%s" as an assessment code — read health is not domain meaning', (code) => {
    // Derived from the vocabulary itself rather than a hand-listed sample, so a new
    // CellUnknownCode is covered here the day it is added.
    const s = spec({ assessment: assessment({ codes: { [code]: { meaning: 'a', safeAction: 'b' } } }) });
    expect(rulesFor(s)).toContain('assessment-code-collides-with-unknown');
  });

  it('rejects an assessment with no evidence behind it', () => {
    expect(rulesFor(spec({ assessment: assessment({ evidence: [] }) }))).toContain('assessment-evidence-empty');
  });

  it('rejects the same evidence path twice — a fact cited twice is not corroborated twice', () => {
    const s = spec({ assessment: assessment({ evidence: ['serving.a', 'serving.a'] }) });
    expect(rulesFor(s)).toContain('assessment-evidence-duplicate');
  });

  it('rejects a code that is its own evidence', () => {
    const s = spec({ assessment: assessment({ evidence: ['assessments.deployedSha'] }) });
    expect(rulesFor(s)).toContain('assessment-evidence-is-assessment-path');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('registry — producer paths are unique WITHIN a shared payload', () => {
  it('refuses a second cell claiming the same assessment path off the same resolver', () => {
    registerCell(spec({ cell: 'a.one', assessment: assessment() }));
    expect(() => registerCell(spec({ cell: 'a.two', assessment: assessment() }))).toThrow(
      /assessment-path-collides-in-shared-payload/,
    );
  });

  it('CONTROL: the same path off a DIFFERENT resolver is fine — different payload, no collision', () => {
    registerCell(spec({ cell: 'a.one', assessment: assessment() }));
    expect(() =>
      registerCell(spec({ cell: 'a.two', resolver: 'other-resolver.ts', assessment: assessment() })),
    ).not.toThrow();
  });

  it('CONTROL: distinct paths off the SAME resolver are fine — that is the intended shape', () => {
    registerCell(spec({ cell: 'a.one', assessment: assessment() }));
    expect(() =>
      registerCell(spec({ cell: 'a.two', assessment: assessment({ path: 'assessments.gateVerdict' }) })),
    ).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('read — a declared code is TRANSPORTED with its meaning and safe action', () => {
  it('resolves a declared code, carrying meaning, safeAction and evidence', async () => {
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue(payload());

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');
    expect(r.assessment.status).toBe('resolved');
    if (r.assessment.status !== 'resolved') return;
    expect(r.assessment.code).toBe('serving');
    expect(r.assessment.meaning).toBe('The running process is executing this sha.');
    expect(r.assessment.safeAction).toBe('Treat the deploy as live.');
    expect(r.assessment.evidence).toEqual([{ path: 'serving.startedSinceCodeChange', value: true }]);
    // The raw value is UNTOUCHED (D-003): assessment is a second property, never an
    // overload of the headline.
    expect(r.value).toBe(true);
  });

  it('ADDITIVITY: an unmigrated cell carries no `assessment` key at all', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue(payload());

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    expect(r.assessment).toBeUndefined();
    // …and the retiring field still ships, because P-003 removes nothing.
    expect(r.falsifier).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('read — every failure converges on `unavailable`, never on a fabricated code', () => {
  /** Every case here must produce this shape; asserted once so a test cannot drift. */
  async function readUnavailable(over: Partial<CellSpec>, resolved: unknown) {
    registerCell(spec({ assessment: assessment(), ...over }));
    dispatchReadOnlyTool.mockResolvedValue(resolved);
    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');
    expect(r.assessment.status).toBe('unavailable');
    if (r.assessment.status !== 'unavailable') throw new Error('unreachable');
    // The three properties that make an unavailable assessment safe rather than merely
    // empty: no code, no meaning, and STILL an action.
    expect(r.assessment.code).toBeNull();
    expect(r.assessment.meaning).toBeNull();
    expect(r.assessment.safeAction).toMatch(/\S/);
    return r.assessment;
  }

  it('refuses a code the spec does not declare, and NAMES it so the drift is diagnosable', async () => {
    // THE CASE THIS CONTRACT EXISTS FOR: a resolver ships a new verdict without its
    // meaning. Passing it through would hand back an enum with no safe action.
    const a = await readUnavailable({}, payload({ assessments: { deployedSha: 'brand-new-verdict' } }));
    expect(a.unknown.detail).toContain('brand-new-verdict');
    expect(a.unknown.code).toBe('insufficient-data');
  });

  it('refuses a non-string at the assessment path rather than coercing it', async () => {
    const a = await readUnavailable({}, payload({ assessments: { deployedSha: 7 } }));
    expect(a.unknown.code).toBe('insufficient-data');
  });

  it('reports a missing assessment path as DRIFT — a registration defect, not a finding', async () => {
    const a = await readUnavailable({}, payload({ assessments: {} }));
    expect(a.unknown.code).toBe('insufficient-data');
    expect(a.unknown.detail).toMatch(/drifted apart/);
    expect(a.truncatedByDoor).toBeUndefined();
  });

  it('withholds a resolved code when its declared evidence did not arrive', async () => {
    // Evidence is what makes a code trustworthy. A verdict whose substantiation went
    // missing is an unverified claim, so it downgrades — but the detail still names
    // the code, which is what makes this diagnosable rather than merely conservative.
    const a = await readUnavailable({}, { positions: { deployed: true }, assessments: { deployedSha: 'serving' } });
    expect(a.unknown.detail).toContain('serving');
    expect(a.unknown.detail).toContain('serving.startedSinceCodeChange');
    expect(a.evidence).toEqual([{ path: 'serving.startedSinceCodeChange', value: null, drifted: true }]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('read — MISSING is not NULL', () => {
  it('a measured NULL evidence value still resolves the assessment', async () => {
    // The distinction the whole plan exists to close, at its sharpest: `null` here is
    // a real measurement ("we looked, there is nothing"), so the code stands.
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue(payload({ serving: { startedSinceCodeChange: null } }));

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');

    expect(r.assessment.status).toBe('resolved');
    expect(r.assessment.evidence).toEqual([{ path: 'serving.startedSinceCodeChange', value: null }]);
    // No drift marker: the path ARRIVED. Marking it would be the exact conflation that
    // once made a correct measurement read as a code bug in a blameless resolver.
    expect(r.assessment.evidence[0]?.drifted).toBeUndefined();
  });

  it('a MISSING evidence key does not resolve it', async () => {
    // Same assertion target, opposite input — the pair is what proves the distinction
    // is real rather than an artifact of one fixture.
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue(payload({ serving: {} }));

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');

    expect(r.assessment.status).toBe('unavailable');
    expect(r.assessment.evidence[0]?.drifted).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('read — a door-truncated payload is UNATTRIBUTABLE, not drift', () => {
  const TRUNCATED = { projection: { truncated: true, fullRead: { tool: 'dev:pipeline_position' } } };

  it('reports truncation rather than blaming the resolver, and hands back the re-read', async () => {
    // WI-38266's split, one field over. Drift sends the reader to FIX a resolver;
    // truncation sends them to RE-READ it. Reporting either as the other either blames
    // a blameless resolver or hides a real defect.
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, ...TRUNCATED });

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');

    expect(r.assessment.status).toBe('unavailable');
    if (r.assessment.status !== 'unavailable') return;
    expect(r.assessment.truncatedByDoor).toBe(true);
    expect(r.assessment.fullRead).toEqual({ tool: 'dev:pipeline_position' });
    expect(r.assessment.unknown.code).toBe('not-measured');
    expect(r.assessment.unknown.detail).toMatch(/UNATTRIBUTABLE/);
    // …and NOT the drift verdict, which would send the reader to fix nothing.
    expect(r.assessment.unknown.detail).not.toMatch(/drifted apart/);
  });

  it('marks evidence truncatedByDoor rather than drifted', async () => {
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue({
      positions: { deployed: true },
      assessments: { deployedSha: 'serving' },
      ...TRUNCATED,
    });

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected a value read with an assessment');

    expect(r.assessment.evidence).toEqual([
      { path: 'serving.startedSinceCodeChange', value: null, truncatedByDoor: true },
    ]);
    expect(r.assessment.evidence[0]?.drifted).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('CONTROLS — the assertions above can actually fail', () => {
  /**
   * The deliberately-WRONG implementation, kept permanently rather than run as a
   * one-shot mutation of the shared tree (which git-sync would commit).
   *
   * This is the shape the real `assessmentFrom` must never take: it passes whatever
   * the payload said straight through as a code, inventing `meaning`/`safeAction` when
   * the spec declares none. It is a plausible implementation — which is the point; the
   * defect it embodies would not look like a bug in review.
   */
  function fabricatingAssessment(raw: unknown, spec_: CellAssessmentSpec) {
    const code = String(raw);
    const declared = spec_.codes[code];
    return {
      status: 'resolved' as const,
      code,
      meaning: declared?.meaning ?? 'no meaning declared',
      safeAction: declared?.safeAction ?? 'proceed',
    };
  }

  it('CALIBRATION: the control agrees with the real reader on a DECLARED code', async () => {
    // Both must agree here, or the disagreement below would prove only that the two
    // differ in general — not that they differ on the property under test.
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue(payload());

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || r.assessment?.status !== 'resolved') throw new Error('expected resolved');

    const control = fabricatingAssessment('serving', assessment());
    expect(control.code).toBe(r.assessment.code);
    expect(control.meaning).toBe(r.assessment.meaning);
  });

  it('and DIVERGES on an undeclared code — which is what the suite above detects', async () => {
    registerCell(spec({ assessment: assessment() }));
    dispatchReadOnlyTool.mockResolvedValue(payload({ assessments: { deployedSha: 'brand-new-verdict' } }));

    const r = await readCell('test.cell', READER, ENV);
    if (r.status !== 'value' || !r.assessment) throw new Error('expected an assessment');

    const control = fabricatingAssessment('brand-new-verdict', assessment());

    // The control manufactures a usable-looking verdict out of nothing…
    expect(control.status).toBe('resolved');
    expect(control.safeAction).toBe('proceed');
    // …where the real reader refuses. If this pair ever agrees, the invariant at the
    // top of this file has been lost and every `unavailable` assertion above is inert.
    expect(r.assessment.status).toBe('unavailable');
    expect(r.assessment.status).not.toBe(control.status);
  });

  it('CONTROL: the registry validator rejects a BAD spec and accepts a good one', async () => {
    // The paired form for the registry half: a validator stuck at "reject everything"
    // or "accept everything" fails exactly one of these two.
    expect(rulesFor(spec({ assessment: assessment({ evidence: [] }) }))).toContain('assessment-evidence-empty');
    expect(rulesFor(spec({ assessment: assessment() }))).toEqual([]);
  });
});
