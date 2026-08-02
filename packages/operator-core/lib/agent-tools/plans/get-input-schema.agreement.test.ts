/**
 * get-input-schema.agreement.test — plan-structured-inputs-2026-08-01 P-013.
 *
 * plans:get-input-schema's own header promises its answer "cannot disagree with a
 * refusal". It could, and it did: `required`/`missing` were computed with the
 * JSON-Schema-only helpers, which see nothing on a `template:` (code-registry zod)
 * plan. Such a plan reported `missing: []` — "nothing to supply" — while every start
 * door refused it with `missing: ['characteristic']`. A UI trusting that read would
 * show a human a complete form and then watch their start be refused with no
 * explanation on screen.
 *
 * P-013 repointed the verb at `planRequiredKeys` / `evaluatePlanStartReadiness` — the
 * gate's own functions. This pins the invariant rather than the implementation: for
 * BOTH schema sources, what the read verb reports must equal what the gate enforces.
 * The final case is the specific regression, written so that reverting to the
 * JSON-only helper fails here loudly instead of silently under-reporting again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { evaluatePlanStartReadiness, planRequiredKeys } from './plan-input-validation';
import { missingRequiredJsonSchemaKeys } from '../../json-schema-validation';
import { registerPlanTemplate, _resetPlanTemplateRegistryForTests } from './template-registry';

const TMPL = 'agreement-tmpl';
const TMPL_SCHEMA = z.object({ characteristic: z.string(), note: z.string().optional() }).strict();

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    harness: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    dryRun: { type: 'boolean' },
  },
  required: ['harness', 'paths'],
} as Record<string, unknown>;

beforeEach(() => {
  _resetPlanTemplateRegistryForTests();
  registerPlanTemplate({ name: TMPL, description: 'agreement fixture', schema: TMPL_SCHEMA });
});

/** Exactly what the widened plans:get-input-schema handler computes for a row. */
function readVerbProjection(ref: { template: string | null; inputSchema: unknown }, values: unknown) {
  const readiness = evaluatePlanStartReadiness(ref, values);
  return {
    required: planRequiredKeys(ref),
    missing: readiness.ready ? [] : readiness.missing,
    ready: readiness.ready,
  };
}

describe('P-013: the read verb and the start gate cannot disagree', () => {
  it('input-schema source: reports exactly the fields the gate refuses on', () => {
    const ref = { template: null, inputSchema: JSON_SCHEMA };
    const projection = readVerbProjection(ref, { harness: 'papercusp' });
    const gate = evaluatePlanStartReadiness(ref, { harness: 'papercusp' });

    expect(projection.required).toEqual(['harness', 'paths']);
    expect(projection.missing).toEqual(['paths']);
    expect(projection.ready).toBe(false);
    expect(gate.ready ? [] : gate.missing).toEqual(projection.missing);
  });

  it('input-schema source: goes ready exactly when the gate admits the plan', () => {
    const ref = { template: null, inputSchema: JSON_SCHEMA };
    const values = { harness: 'papercusp', paths: ['packages/a'] };
    expect(readVerbProjection(ref, values)).toEqual({
      required: ['harness', 'paths'],
      missing: [],
      ready: true,
    });
  });

  it('a plan declaring no schema reads ready — the no-op case for the whole corpus', () => {
    expect(readVerbProjection({ template: null, inputSchema: null }, null)).toEqual({
      required: [],
      missing: [],
      ready: true,
    });
  });

  it('template source: names the missing zod field instead of reporting none (the P-013 fix)', () => {
    const ref = { template: TMPL, inputSchema: null };
    const projection = readVerbProjection(ref, {});
    const gate = evaluatePlanStartReadiness(ref, {});

    // The gate refuses, naming the field...
    expect(gate.ready).toBe(false);
    expect(gate.ready ? [] : gate.missing).toEqual(['characteristic']);
    // ...and the read verb now says the same thing.
    expect(projection.required).toEqual(['characteristic']);
    expect(projection.missing).toEqual(['characteristic']);
    expect(projection.ready).toBe(false);

    // The regression guard: the helper this verb USED to call is blind to a zod
    // schema, so it answers "nothing missing" for the very plan the gate refuses.
    // If someone repoints the handler back at it, the assertion above fails and
    // this line explains why.
    expect(missingRequiredJsonSchemaKeys(null, {})).toEqual([]);
  });

  it('template source: satisfied required field reads ready', () => {
    expect(readVerbProjection({ template: TMPL, inputSchema: null }, { characteristic: 'x' })).toEqual(
      { required: ['characteristic'], missing: [], ready: true },
    );
  });

  it('a plan declaring BOTH sources reads not-ready, matching the gate refusal', () => {
    const ref = { template: TMPL, inputSchema: JSON_SCHEMA };
    const projection = readVerbProjection(ref, {});
    expect(projection.ready).toBe(false);
    // A conflict is not an absence — nothing is reported "missing", because supplying
    // a field would not fix it. The hint is what tells the human to clear one source.
    expect(projection.missing).toEqual([]);
    const gate = evaluatePlanStartReadiness(ref, {});
    expect(gate.ready ? null : gate.code).toBe('schema_conflict');
  });
});
