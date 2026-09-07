/**
 * plan-input-validation.test — plan-structured-inputs-2026-08-01 P-004 + P-005.
 *
 * The START GATE oracle every start door consults. The behaviours pinned here are the
 * ones the feature is FOR:
 *   - a required field that was not supplied blocks the start, and is NAMED;
 *   - an arg error (wrong type / unknown key) blocks the start;
 *   - a plan with no declared schema is always startable (why no flag is needed);
 *   - WRITE tolerates partial data while START does not (D-004) — the split that lets
 *     a plan be drafted incrementally yet never run half-specified;
 *   - a schema that cannot be checked FAILS CLOSED, never open.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  validatePlanData,
  evaluatePlanStartReadiness,
  planSchemaSource,
  planRequiredKeys,
  zodRequiredKeys,
} from './plan-input-validation';
import { registerPlanTemplate, _resetPlanTemplateRegistryForTests } from './template-registry';

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    harness: { type: 'string', minLength: 1 },
    paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
    dryRun: { type: 'boolean' },
  },
  required: ['harness', 'paths'],
  additionalProperties: false,
} as Record<string, unknown>;

const TMPL = 'test-tmpl';
const TMPL_SCHEMA = z.object({ characteristic: z.string(), note: z.string().optional() }).strict();

beforeEach(() => {
  _resetPlanTemplateRegistryForTests();
  registerPlanTemplate({ name: TMPL, description: 'test fixture', schema: TMPL_SCHEMA });
});

describe('planSchemaSource', () => {
  it('names the declared source, and flags declaring both', () => {
    expect(planSchemaSource({ template: null, inputSchema: null })).toBe('none');
    expect(planSchemaSource({ template: TMPL, inputSchema: null })).toBe('template');
    expect(planSchemaSource({ template: null, inputSchema: AUDIT_SCHEMA })).toBe('input-schema');
    expect(planSchemaSource({ template: TMPL, inputSchema: AUDIT_SCHEMA })).toBe('conflict');
  });
});

describe('zodRequiredKeys / planRequiredKeys', () => {
  it('reads required-ness off a zod object shape', () => {
    expect(zodRequiredKeys(TMPL_SCHEMA)).toEqual(['characteristic']);
  });

  it('degrades to [] rather than throwing on a non-object schema', () => {
    expect(zodRequiredKeys(z.string())).toEqual([]);
    expect(zodRequiredKeys(undefined)).toEqual([]);
  });

  it('reports required names for either source', () => {
    expect(planRequiredKeys({ template: null, inputSchema: AUDIT_SCHEMA })).toEqual([
      'harness',
      'paths',
    ]);
    expect(planRequiredKeys({ template: TMPL, inputSchema: null })).toEqual(['characteristic']);
    expect(planRequiredKeys({ template: null, inputSchema: null })).toEqual([]);
  });
});

describe('validatePlanData — the WRITE-side check (partial is fine)', () => {
  it('accepts PARTIAL data missing a required field (D-004: drafting stays possible)', () => {
    const r = validatePlanData({ template: null, inputSchema: AUDIT_SCHEMA }, { paths: ['a'] });
    expect(r.ok).toBe(true);
  });

  it('still rejects a genuine arg error — wrong type', () => {
    const r = validatePlanData(
      { template: null, inputSchema: AUDIT_SCHEMA },
      { harness: 'p', paths: 'not-an-array' },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_data', source: 'input-schema' });
  });

  it('still rejects an unknown key (additionalProperties:false catches a typo)', () => {
    const r = validatePlanData(
      { template: null, inputSchema: AUDIT_SCHEMA },
      { harnes: 'p', paths: ['a'] },
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_data' });
  });

  it('no_schema when the plan declares neither source', () => {
    expect(validatePlanData({ template: null, inputSchema: null }, { a: 1 })).toEqual({
      ok: false,
      code: 'no_schema',
    });
  });

  it('schema_conflict when a plan declares both sources', () => {
    expect(
      validatePlanData({ template: TMPL, inputSchema: AUDIT_SCHEMA }, {}),
    ).toMatchObject({ ok: false, code: 'schema_conflict', template: TMPL });
  });

  it('the two sources differ ON WRITE, deliberately: registry stays strict', () => {
    // input-schema relaxes top-level required on write so a parameterized plan can be
    // drafted incrementally. The registry path does NOT: its schemas describe
    // code-defined domain objects (a rubric) whose readers assume a complete value, so
    // a half-written one must not reach the store. Both agree at START, which is where
    // the user-visible rule lives. Do not "fix" this asymmetry into uniformity.
    expect(
      validatePlanData({ template: null, inputSchema: AUDIT_SCHEMA }, { paths: ['a'] }).ok,
    ).toBe(true);
    expect(validatePlanData({ template: TMPL, inputSchema: null }, { note: 'x' })).toMatchObject({
      ok: false,
      code: 'invalid_data',
      source: 'template',
    });
  });

  it('still enforces NESTED required — supplying an object means supplying it well-formed', () => {
    const nested = {
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: { repo: { type: 'string' }, ref: { type: 'string' } },
          required: ['repo'],
        },
      },
      required: ['target'],
    } as Record<string, unknown>;
    // top-level `target` absent → fine on write (start gate owns that)
    expect(validatePlanData({ template: null, inputSchema: nested }, {}).ok).toBe(true);
    // but a supplied `target` missing its own required `repo` → a real violation
    expect(
      validatePlanData({ template: null, inputSchema: nested }, { target: { ref: 'main' } }),
    ).toMatchObject({ ok: false, code: 'invalid_data' });
  });

  it('registry path returns the zod-COERCED data', () => {
    const r = validatePlanData({ template: TMPL, inputSchema: null }, { characteristic: 'x' });
    expect(r).toMatchObject({ ok: true, source: 'template' });
    if (!r.ok) throw new Error('unreachable');
    expect(r.data).toEqual({ characteristic: 'x' });
  });
});

describe('evaluatePlanStartReadiness — THE START GATE', () => {
  it('a plan with NO declared schema is always startable (why the gate needs no flag)', () => {
    expect(evaluatePlanStartReadiness({ template: null, inputSchema: null }, null)).toEqual({
      ready: true,
      source: 'none',
    });
  });

  it('BLOCKS on a missing required field and NAMES it', () => {
    const r = evaluatePlanStartReadiness(
      { template: null, inputSchema: AUDIT_SCHEMA },
      { paths: ['a'] },
    );
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.code).toBe('missing_required');
    expect(r.missing).toEqual(['harness']);
    expect(r.hint).toMatch(/harness/);
  });

  it('names EVERY missing required field, not just the first', () => {
    const r = evaluatePlanStartReadiness({ template: null, inputSchema: AUDIT_SCHEMA }, {});
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.missing).toEqual(['harness', 'paths']);
  });

  it('reports missing fields AND invalid supplied values in one request', () => {
    const r = evaluatePlanStartReadiness(
      { template: null, inputSchema: AUDIT_SCHEMA }, { paths: 'wrong', dryRun: 'wrong' },
    );
    expect(r).toMatchObject({ ready: false, code: 'missing_required', missing: ['harness'] });
    if (r.ready) throw new Error('unreachable');
    expect(r.issues.some((issue) => issue.includes('paths'))).toBe(true);
    expect(r.issues.some((issue) => issue.includes('dryRun'))).toBe(true);
    expect(r.hint).toContain('schema violations');
  });

  it('also collects registry-schema violations while a required field is absent', () => {
    const r = evaluatePlanStartReadiness({ template: TMPL, inputSchema: null }, { note: 42 });
    expect(r).toMatchObject({ ready: false, code: 'missing_required', missing: ['characteristic'] });
    if (r.ready) throw new Error('unreachable');
    expect(r.issues.some((issue) => issue.includes('note'))).toBe(true);
  });

  it.each([false, true, [], 'schema', 1])('does not mistake malformed schema %j for a legacy plan', (inputSchema) => {
    expect(evaluatePlanStartReadiness({ template: null, inputSchema }, {}))
      .toMatchObject({ ready: false, code: 'bad_schema', source: 'input-schema' });
  });

  it('keeps schema compilation failure and discoverable missing keys together', () => {
    expect(evaluatePlanStartReadiness({
      template: null, inputSchema: { type: 'banana', required: ['harness'] },
    }, {})).toMatchObject({ ready: false, code: 'bad_schema', missing: ['harness'] });
  });

  it('BLOCKS on an arg error even when every required field is present', () => {
    const r = evaluatePlanStartReadiness(
      { template: null, inputSchema: AUDIT_SCHEMA },
      { harness: 'p', paths: ['a'], dryRun: 'yes-please' },
    );
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.code).toBe('invalid_data');
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('ALLOWS a fully-supplied, valid set', () => {
    expect(
      evaluatePlanStartReadiness(
        { template: null, inputSchema: AUDIT_SCHEMA },
        { harness: 'papercusp', paths: ['a'], dryRun: true },
      ),
    ).toEqual({ ready: true, source: 'input-schema' });
  });

  it('the same WRITE-vs-START split for the registry source', () => {
    const partial = { note: 'x' }; // `characteristic` is required by TMPL_SCHEMA
    expect(evaluatePlanStartReadiness({ template: TMPL, inputSchema: null }, partial)).toMatchObject({
      ready: false,
      code: 'missing_required',
      missing: ['characteristic'],
    });
    expect(
      evaluatePlanStartReadiness({ template: TMPL, inputSchema: null }, { characteristic: 'x' }),
    ).toEqual({ ready: true, source: 'template' });
  });

  it('FAILS CLOSED on a schema that cannot be checked', () => {
    // A non-compilable schema can still reach the column via federation or direct SQL,
    // so the gate refuses rather than treating "could not check" as "nothing required".
    const r = evaluatePlanStartReadiness(
      { template: null, inputSchema: { type: 'banana' } },
      { anything: 1 },
    );
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.code).toBe('bad_schema');
  });

  it('FAILS CLOSED on an unregistered template type', () => {
    const r = evaluatePlanStartReadiness({ template: 'nope', inputSchema: null }, {});
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.code).toBe('unknown_template');
  });

  it('FAILS CLOSED when a plan declares two schema sources', () => {
    const r = evaluatePlanStartReadiness(
      { template: TMPL, inputSchema: AUDIT_SCHEMA },
      { characteristic: 'x', harness: 'p', paths: ['a'] },
    );
    expect(r.ready).toBe(false);
    if (r.ready) throw new Error('unreachable');
    expect(r.code).toBe('schema_conflict');
  });

  it('treats a null/absent value blob as supplying nothing, not as an error', () => {
    const r = evaluatePlanStartReadiness({ template: null, inputSchema: AUDIT_SCHEMA }, null);
    expect(r).toMatchObject({ ready: false, code: 'missing_required', missing: ['harness', 'paths'] });
  });
});
