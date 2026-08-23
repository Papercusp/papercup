/**
 * set-output-schema.test.ts — external-triggers-gmail-slack-2026-08-22 P-026 / D-017.
 *
 * Pins the pure DECLARE-time core `evaluateSetOutputSchema`: the compile-before-persist
 * rule, the always-allowed clear, and — the one thing that genuinely distinguishes this
 * verb from its input sibling — that a code-registry `template:` type is NOT a conflict
 * here. The plans:set-output-schema tool runs exactly this inside withPlanLock.
 *
 * The template case is tested against the INPUT verb too, in the same file, on purpose.
 * The asymmetry is a deliberate design decision (a `template` describes a plan's
 * ARGUMENTS, so it competes with input_schema and not with output_schema), and a test
 * that only asserted "outputs accept a templated plan" would still pass if someone
 * later relaxed the input rule and erased the distinction. Asserting BOTH sides pins
 * the contrast itself.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSetOutputSchema } from './set-output-schema';
import { evaluateSetInputSchema } from './set-input-schema';

const SCHEMA = {
  type: 'object',
  properties: { briefId: { type: 'string' }, filedIds: { type: 'array', items: { type: 'string' } } },
  required: ['briefId', 'filedIds'],
  additionalProperties: false,
} as Record<string, unknown>;

/** A minimal non-legacy plan; `extra` appends frontmatter lines (e.g. `\ntemplate: x`). */
const planWith = (extra: string) => `---
title: T
slug: s
status: ready${extra}
---

## Now
**State:** x

**Next:** y
`;

describe('P-026: evaluateSetOutputSchema (declare-time core)', () => {
  it('not_found when the plan is absent', () => {
    const r = evaluateSetOutputSchema(null, SCHEMA, 's');
    expect(r.value).toEqual({ ok: false, code: 'not_found' });
    expect(r.outputSchema).toBeUndefined();
  });

  it('legacy_plan when the body carries no frontmatter', () => {
    const r = evaluateSetOutputSchema('just prose, no frontmatter block', SCHEMA, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'legacy_plan' });
    expect(r.outputSchema).toBeUndefined();
  });

  it('ok + the patch + the required list on a valid declare', () => {
    const r = evaluateSetOutputSchema(planWith(''), SCHEMA, 's');
    expect(r.value).toMatchObject({ ok: true, slug: 's', cleared: false });
    expect((r.value as { required: string[] }).required).toEqual(['briefId', 'filedIds']);
    expect(r.newBody).toBeNull(); // structured-only write — never touches content
    expect(r.outputSchema).toEqual({ schema: SCHEMA });
  });

  it('bad_schema when the schema does not ajv-compile — rejected, never persisted', () => {
    // Same fail-loud reason as inputs, one door later: a schema stored un-compilable
    // could not be checked when the run COMPLETES, and the completion gate must never
    // read "could not check" as "nothing was promised".
    const r = evaluateSetOutputSchema(planWith(''), { type: 'banana' }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'bad_schema' });
    expect(r.outputSchema).toBeUndefined();
  });

  it('clearing is allowed — un-declaring outputs makes a valid terminal-only plan', () => {
    const r = evaluateSetOutputSchema(planWith(''), null, 's');
    expect(r.value).toMatchObject({ ok: true, cleared: true });
    expect(r.outputSchema).toEqual({ schema: null });
  });

  it('a code-registry template type is NOT a conflict for outputs — and IS one for inputs', () => {
    const templated = planWith('\ntemplate: rubric');

    // The output side accepts it: `template` describes the plan's ARGUMENTS, so it is
    // not a second source for the plan's PRODUCT and there is nothing to arbitrate.
    const out = evaluateSetOutputSchema(templated, SCHEMA, 's');
    expect(out.value).toMatchObject({ ok: true, cleared: false });
    expect(out.outputSchema).toEqual({ schema: SCHEMA });

    // The input side still refuses it (D-002). Asserted here so the CONTRAST is pinned:
    // if the input exclusion is ever dropped, this test fails rather than silently
    // leaving the output verb's "no exclusion" claim untested.
    const inp = evaluateSetInputSchema(templated, SCHEMA, 's');
    expect(inp.value).toMatchObject({ ok: false, code: 'template_conflict' });
  });
});
