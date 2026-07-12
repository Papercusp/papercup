/**
 * rubrics-loss-guards.test.ts — the WI-4287 pure surfaces: assertNoSilentRubricLoss
 * (the propose whole-document-replace loss-guard), rubricCompleteness (the per-aspect
 * testing-procedure report), the criterion `replication` field end-to-end through the
 * template schema + planRowToRubric mapping.
 *
 * [owner:Avi 2026-07-12] "how can we improve our system so that the next agent who
 * updates the rubric also knows to add the full detailed testing procedure and doesn't
 * drop it? … i think each aspect should come with its own testing procedure in addition
 * to one main one for the whole rubric." These tests pin exactly that: a proposal that
 * silently drops a criterion or guts its procedure is REJECTED with a teaching error;
 * gaps in per-aspect procedures are REPORTED.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoSilentRubricLoss,
  rubricCompleteness,
  planRowToRubric,
  REPLICATION_DRILL_MARKER,
  METHOD_SHRINK_GUARD_MIN_CHARS,
  type Rubric,
  type RubricCriterion,
  type ProposeRubricInput,
} from './rubrics';
import { rubricCriterionSchema, rubricTemplateDataSchema } from './agent-tools/plans/rubric-template';
import { classifyToolError } from './harness/improvements/tool-error-classifier';

const LONG_DRILL =
  `${REPLICATION_DRILL_MARKER} — full end-to-end procedure: create two SYNTHETIC work items, ` +
  'park them on a dead holder id, author the drill plan, spawn a headless subject with the ' +
  'verbatim neutral brief, then grade via the tool_invocations SQL and clean up the fixtures. ' +
  'Repeat lines to exceed the shrink-guard floor. '.repeat(4);

const crit = (over: Partial<RubricCriterion> & { key: string }): RubricCriterion => ({
  title: `Criterion ${over.key}`,
  model: 'How this is supposed to work.',
  method: 'How to investigate it.',
  driftMarkers: 'What broken looks like.',
  ...over,
});

const rubric = (criteria: RubricCriterion[], over: Partial<Rubric> = {}): Rubric => ({
  rubricId: 'su-agent-behavior',
  workspaceId: 'default',
  characteristic: 'su-behavior',
  title: 'SU agent behavior',
  description: 'test fixture',
  criteria,
  ratingScale: ['pass', 'partial', 'fail', 'unknown'],
  methodRef: 'su-agent-behavior',
  status: 'active',
  createdBy: 'su-1',
  proposedBy: 'su-1',
  ratifiedBy: 'su-1',
  createdAt: '2026-07-12',
  updatedAt: '2026-07-12T00:00:00.000Z',
  ...over,
});

const proposal = (criteria: RubricCriterion[], over: Partial<ProposeRubricInput> = {}): ProposeRubricInput => ({
  rubricId: 'su-agent-behavior',
  characteristic: 'su-behavior',
  title: 'SU agent behavior',
  criteria,
  ...over,
});

describe('assertNoSilentRubricLoss (WI-4287 propose loss-guard)', () => {
  it('a brand-new rubric (stored=null) always passes — the seeder/new-propose path', () => {
    expect(() => assertNoSilentRubricLoss(null, proposal([crit({ key: 'a' })]))).not.toThrow();
  });

  it('an identical re-propose passes (idempotent upsert stays idempotent)', () => {
    const c = [crit({ key: 'a', method: LONG_DRILL }), crit({ key: 'b' })];
    expect(() => assertNoSilentRubricLoss(rubric(c), proposal(c))).not.toThrow();
  });

  it('ADDING a criterion passes (superset never loses content)', () => {
    const stored = rubric([crit({ key: 'a' })]);
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' }), crit({ key: 'new' })])),
    ).not.toThrow();
  });

  it('dropping a stored criterion WITHOUT a dropKeys ack throws, naming the key and the fix', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'batched-tool-calls' })]);
    expect(() => assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })]))).toThrowError(
      /SILENTLY LOSE[\s\S]*'batched-tool-calls'[\s\S]*dropKeys/,
    );
  });

  it('EI-10148: the loss-guard rejection classifies as `caller`, not `structural` (no spurious auto-implement EI)', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'batched-tool-calls' })]);
    let thrown: unknown;
    try {
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })]));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // The teaching content is preserved (the caller still learns the fix)...
    expect(msg).toMatch(/SILENTLY LOSE[\s\S]*dropKeys/);
    // ...but it now carries the `invalid_args:` caller convention, so the tool-error
    // watchdog classifies it `caller` (DX/schema) instead of the `structural` default —
    // the loss-guard is a caller-input rejection, NOT a tool bug for the auto-implement lane.
    expect(classifyToolError(undefined, 'handler_error', msg)).toBe('caller');
  });

  it('dropping a stored criterion WITH the dropKeys ack passes', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'b' })]);
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })], { dropKeys: ['b'] })),
    ).not.toThrow();
  });

  it('a >40% shrink of a long method throws with the before/after char counts', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: `${REPLICATION_DRILL_MARKER}: see docs.` })]);
    expect(() => assertNoSilentRubricLoss(stored, gutted)).toThrowError(
      /criterion 'a' procedure text[\s\S]*chars[\s\S]*allowMethodShrink/,
    );
  });

  it('losing the REPLICATION DRILL marker throws even when the text stays long', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    // Same length, marker stripped — length guard alone would pass; marker guard must not.
    const stripped = LONG_DRILL.replaceAll(REPLICATION_DRILL_MARKER, 'procedure notes');
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a', method: stripped })])),
    ).toThrowError(/LOSES its 'REPLICATION DRILL'/);
  });

  it('allowMethodShrink WITHOUT a shrinkReason still throws (a conscious edit must be explained)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: 'short now' })], { allowMethodShrink: true });
    expect(() => assertNoSilentRubricLoss(stored, gutted)).toThrowError(/shrinkReason/);
  });

  it('allowMethodShrink + shrinkReason passes (the explicit override)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: 'short now' })], {
      allowMethodShrink: true,
      shrinkReason: 'drill moved to the shared runbook; method now points at it',
    });
    expect(() => assertNoSilentRubricLoss(stored, gutted)).not.toThrow();
  });

  it('MOVING the drill from .method into .replication passes — combined text is what is compared (D-002)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const moved = proposal([
      crit({ key: 'a', method: 'Drill lives in this criterion’s replication field.', replication: LONG_DRILL }),
    ]);
    expect(() => assertNoSilentRubricLoss(stored, moved)).not.toThrow();
  });

  it('rewording a SHORT method (under the guard floor, no marker) passes — no noise on small edits', () => {
    const short = 'Check the ledger for stalls.';
    expect(short.length).toBeLessThan(METHOD_SHRINK_GUARD_MIN_CHARS);
    const stored = rubric([crit({ key: 'a', method: short })]);
    expect(() => assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a', method: 'Check it.' })]))).not.toThrow();
  });
});

describe('rubricCompleteness (WI-4287 per-aspect procedure report)', () => {
  it('complete when every criterion carries a procedure and methodRef is set', () => {
    const r = rubric([
      crit({ key: 'a', replication: 'fixtures → prompt → grade → cleanup' }),
      crit({ key: 'b', method: `${LONG_DRILL}` }), // marker embedded in method also counts
    ]);
    const c = rubricCompleteness(r);
    expect(c.complete).toBe(true);
    expect(c.criteriaWithoutReplication).toEqual([]);
    expect(c.methodRefMissing).toBe(false);
    expect(c.note).toBeUndefined();
  });

  it('lists criteria lacking any procedure and flags a missing methodRef, with a teaching note', () => {
    const r = rubric([crit({ key: 'bare' }), crit({ key: 'ok', replication: 'the drill' })], {
      methodRef: null,
    });
    const c = rubricCompleteness(r);
    expect(c.complete).toBe(false);
    expect(c.criteriaWithoutReplication).toEqual(['bare']);
    expect(c.methodRefMissing).toBe(true);
    expect(c.note).toMatch(/bare/);
    expect(c.note).toMatch(/methodRef/);
  });
});

describe('criterion `replication` field end-to-end (schema + plan-row mapping)', () => {
  const baseCrit = {
    key: 'a',
    title: 'A',
    model: 'm',
    method: 'how',
    driftMarkers: 'bad',
  };

  it('rubricCriterionSchema accepts an optional replication string and stays strict on unknowns', () => {
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replication: 'the drill' }).success).toBe(true);
    expect(rubricCriterionSchema.safeParse(baseCrit).success).toBe(true);
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replication: '' }).success).toBe(false);
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replicatoin: 'typo' }).success).toBe(false);
  });

  it('planRowToRubric passes replication through (and omits it when absent)', () => {
    const row = {
      plan_slug: 'r1',
      workspace_id: 'default',
      harness_slug: 'papercusp',
      title: 'R1',
      status: 'active' as string | null,
      created: '2026-07-12',
      updated: '2026-07-12',
      updated_at: '2026-07-12T00:00:00.000Z',
      owner: 'su-1',
      archived: false,
      template_data: {
        characteristic: 'c',
        criteria: [{ ...baseCrit, replication: 'the drill' }, { ...baseCrit, key: 'b' }],
        ratingScale: ['healthy', 'unknown'],
      },
    };
    expect(rubricTemplateDataSchema.safeParse(row.template_data).success).toBe(true);
    const mapped = planRowToRubric(row);
    expect(mapped).not.toBeNull();
    expect(mapped?.criteria[0]?.replication).toBe('the drill');
    expect(mapped?.criteria[1]).not.toHaveProperty('replication');
  });
});
