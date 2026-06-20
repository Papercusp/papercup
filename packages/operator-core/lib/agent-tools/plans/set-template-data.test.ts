/**
 * set-template-data.test.ts — v2 plan-templates-and-rubric-v2-2026-06-20 P-005.
 *
 * Pins the VALIDATE-ON-WRITE core `evaluateSetTemplateData` (the pure sibling of
 * evaluateSetContent): it resolves the plan's `template:` TYPE, validates the data
 * against that type's registry zod schema, and returns the template_data patch to
 * persist OR a structured, fail-loud rejection — never throws, never silent-strips.
 * (The plans:set-template-data tool runs exactly this inside withPlanLock; the
 * column-write + revision wiring is covered by the plans integration suite.)
 *
 * Coverage added post-hoc (the P-005 build shipped the tools without unit tests) —
 * the pure core is the error-prone surface, so it gets the unit pins here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { evaluateSetTemplateData } from './set-template-data';
import { registerPlanTemplate, _resetPlanTemplateRegistryForTests } from './template-registry';

const TMPL = 'test-tmpl';
// Strict so the "rejects unknown fields" case is real (mirrors the P-012 fail-loud theme).
const SCHEMA = z.object({ characteristic: z.string(), score: z.number() }).strict();

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

beforeEach(() => {
  _resetPlanTemplateRegistryForTests();
  registerPlanTemplate({ name: TMPL, description: 'test fixture', schema: SCHEMA });
});

describe('P-005: evaluateSetTemplateData (validate-on-write core)', () => {
  it('not_found when the plan is absent', () => {
    const r = evaluateSetTemplateData(null, { characteristic: 'a', score: 1 }, 's');
    expect(r.value).toEqual({ ok: false, code: 'not_found' });
    expect(r.templateData).toBeUndefined();
  });

  it('legacy_plan when the body carries no frontmatter', () => {
    const r = evaluateSetTemplateData('just prose, no frontmatter block', { characteristic: 'a', score: 1 }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'legacy_plan' });
    expect(r.templateData).toBeUndefined();
  });

  it('no_template when the plan declares no template: type', () => {
    const r = evaluateSetTemplateData(planWith(''), { characteristic: 'a', score: 1 }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'no_template' });
  });

  it('unknown_template (fail-loud + the known-types list) when the type is unregistered', () => {
    const r = evaluateSetTemplateData(planWith('\ntemplate: nope'), { characteristic: 'a', score: 1 }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'unknown_template', template: 'nope' });
    expect((r.value as { known: string[] }).known).toContain(TMPL);
    expect(r.templateData).toBeUndefined();
  });

  it('invalid_data (fail-loud + issues) when data violates the registered schema', () => {
    // missing the required `score`
    const r = evaluateSetTemplateData(planWith(`\ntemplate: ${TMPL}`), { characteristic: 'a' }, 's');
    expect(r.value).toMatchObject({ ok: false, code: 'invalid_data', template: TMPL });
    expect((r.value as { issues: string[] }).issues.length).toBeGreaterThan(0);
    expect(r.templateData).toBeUndefined();
  });

  it('invalid_data on UNKNOWN data fields (strict schema → never silently strips)', () => {
    const r = evaluateSetTemplateData(
      planWith(`\ntemplate: ${TMPL}`),
      { characteristic: 'a', score: 2, stowaway: 'x' },
      's',
    );
    expect(r.value).toMatchObject({ ok: false, code: 'invalid_data', template: TMPL });
  });

  it('ok + the schema-coerced template_data patch on a valid write', () => {
    const r = evaluateSetTemplateData(planWith(`\ntemplate: ${TMPL}`), { characteristic: 'a', score: 2 }, 's');
    expect(r.value).toMatchObject({ ok: true, slug: 's', template: TMPL });
    expect(r.newBody).toBeNull(); // structured-only write — never touches content
    expect(r.templateData).toEqual({ data: { characteristic: 'a', score: 2 } });
  });
});
