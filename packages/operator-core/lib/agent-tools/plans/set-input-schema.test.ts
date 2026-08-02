/**
 * set-input-schema.test.ts — plan-structured-inputs-2026-08-01 P-003.
 *
 * Pins the pure DECLARE-time core `evaluateSetInputSchema` (the sibling of
 * evaluateSetTemplateData): the mutual exclusion with a code-registry `template:`
 * type (D-002), the compile-before-persist rule, and the always-allowed clear.
 * The plans:set-input-schema tool runs exactly this inside withPlanLock.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSetInputSchema } from './set-input-schema';

const SCHEMA = {
  type: 'object',
  properties: { harness: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
  required: ['harness', 'paths'],
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

describe('P-003: evaluateSetInputSchema (declare-time core)', () => {
  it('not_found when the plan is absent', () => {
    const r = evaluateSetInputSchema(null, SCHEMA, 's');
    expect(r.value).toEqual({ ok: false, code: 'not_found' });
    expect(r.inputSchema).toBeUndefined();
  });

  it('legacy_plan when the body carries no frontmatter', () => {
    const r = evaluateSetInputSchema('just prose, no frontmatter block', SCHEMA, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'legacy_plan' });
    expect(r.inputSchema).toBeUndefined();
  });

  it('ok + the patch + the required list on a valid declare', () => {
    const r = evaluateSetInputSchema(planWith(''), SCHEMA, 's');
    expect(r.value).toMatchObject({ ok: true, slug: 's', cleared: false });
    expect((r.value as { required: string[] }).required).toEqual(['harness', 'paths']);
    expect(r.newBody).toBeNull(); // structured-only write — never touches content
    expect(r.inputSchema).toEqual({ schema: SCHEMA });
  });

  it('bad_schema when the schema does not ajv-compile — rejected, never persisted', () => {
    // A schema stored un-compilable could not be checked at start time, and the gate
    // must never read "could not check" as "nothing was required".
    const r = evaluateSetInputSchema(planWith(''), { type: 'banana' }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'bad_schema' });
    expect(r.inputSchema).toBeUndefined();
  });

  it('template_conflict — D-002 mutual exclusion with a code-registry template type', () => {
    const r = evaluateSetInputSchema(planWith('\ntemplate: rubric'), SCHEMA, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'template_conflict', template: 'rubric' });
    expect(r.inputSchema).toBeUndefined();
  });

  it('clearing is allowed even on a template plan — a wedged plan must have a way out', () => {
    const r = evaluateSetInputSchema(planWith('\ntemplate: rubric'), null, 's');
    expect(r.value).toMatchObject({ ok: true, cleared: true });
    expect(r.inputSchema).toEqual({ schema: null });
  });
});
