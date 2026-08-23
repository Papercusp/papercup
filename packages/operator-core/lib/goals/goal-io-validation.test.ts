/**
 * goal-io-validation — pure seam tests (work-on-everything-goal-2026-08-23
 * P-021). No PG: both evaluators are DB-free by design, exactly like the plan
 * pair they mirror.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateGoalStartInputs,
  evaluateGoalWindDownOutputs,
} from './goal-io-validation';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scope'],
  properties: {
    scope: { type: 'string' },
    budgetWindow: { type: 'number' },
    nested: {
      type: 'object',
      required: ['inner'],
      properties: { inner: { type: 'string' } },
    },
  },
};

describe('evaluateGoalStartInputs', () => {
  it('no schema declared ⇒ always ready; supplied inputs carried unvalidated', () => {
    expect(evaluateGoalStartInputs(null, null)).toEqual({ ready: true, inputs: null });
    expect(evaluateGoalStartInputs(null, { anything: 1 })).toEqual({
      ready: true,
      inputs: { anything: 1 },
    });
    // Empty-object schema is "no constraint declared", same as the shared seam.
    expect(evaluateGoalStartInputs({}, { x: 1 })).toEqual({ ready: true, inputs: { x: 1 } });
  });

  it('missing required field refuses with the actionable missing[] list, not an ajv message', () => {
    const v = evaluateGoalStartInputs(inputSchema, { budgetWindow: 5 });
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('missing_required');
    expect(v.missing).toEqual(['scope']);
    expect(v.hint).toContain('scope');
  });

  it('invalid value refuses as invalid_inputs with issues', () => {
    const v = evaluateGoalStartInputs(inputSchema, { scope: 42 });
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('invalid_inputs');
    expect(v.issues.length).toBeGreaterThan(0);
  });

  it('mistyped argument name is an error (additionalProperties: false), never silently ignored', () => {
    const v = evaluateGoalStartInputs(inputSchema, { scope: 'x', scop: 'typo' });
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('invalid_inputs');
  });

  it('NESTED required stays enforced even though top-level required is owned by missing[]', () => {
    const v = evaluateGoalStartInputs(inputSchema, { scope: 'x', nested: {} });
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('invalid_inputs');
  });

  it('complete, valid inputs are ready and carried', () => {
    const v = evaluateGoalStartInputs(inputSchema, { scope: 'docs', budgetWindow: 604800 });
    expect(v).toEqual({ ready: true, inputs: { scope: 'docs', budgetWindow: 604800 } });
  });

  it('an uncompilable schema refuses (fail-closed), never passes unchecked', () => {
    const v = evaluateGoalStartInputs({ type: 'object', properties: 'nonsense' }, { a: 1 });
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('bad_schema');
  });

  it('non-object inputs supply nothing (array/scalar normalize to {})', () => {
    const v = evaluateGoalStartInputs(inputSchema, ['not', 'an', 'object']);
    expect(v.ready).toBe(false);
    if (v.ready) throw new Error('unreachable');
    expect(v.code).toBe('missing_required');
  });
});

const outputSchema = {
  type: 'object',
  required: ['report'],
  properties: {
    report: { type: 'string' },
    count: { type: 'number' },
  },
};

describe('evaluateGoalWindDownOutputs', () => {
  it("handoff records nothing — the goal stays active, whatever was passed", () => {
    expect(
      evaluateGoalWindDownOutputs({ outputSchema, outputs: { report: 'r' }, disposition: 'handoff' }),
    ).toEqual({ ok: true, outputs: null });
  });

  it('no schema + no outputs is the ordinary ok', () => {
    expect(
      evaluateGoalWindDownOutputs({ outputSchema: null, outputs: null, disposition: 'achieved' }),
    ).toEqual({ ok: true, outputs: null });
  });

  it('outputs supplied with NO declared schema refuse — unpromised values are a caller bug', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema: null,
      outputs: { surprise: 1 },
      disposition: 'achieved',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('no_outputs_declared');
  });

  it("achieved with a declared-required output unfilled fails LOUDLY (missing_outputs)", () => {
    const v = evaluateGoalWindDownOutputs({ outputSchema, outputs: {}, disposition: 'achieved' });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('missing_outputs');
    expect(v.missing).toEqual(['report']);
    expect(v.hint).toContain('killed');
  });

  it('achieved with a null-valued required output counts as missing (plan publication rule)', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema,
      outputs: { report: null },
      disposition: 'achieved',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('missing_outputs');
  });

  it('achieved with invalid values refuses as invalid_outputs', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema,
      outputs: { report: 'ok', count: 'not-a-number' },
      disposition: 'achieved',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('invalid_outputs');
  });

  it('achieved with complete valid outputs publishes them', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema,
      outputs: { report: 'shipped', count: 3 },
      disposition: 'achieved',
    });
    expect(v).toEqual({ ok: true, outputs: { report: 'shipped', count: 3 } });
  });

  it('achieved holds a datatype-annotated field to the canonical shape when resolved', () => {
    const schema = {
      type: 'object',
      required: ['msg'],
      properties: { msg: { datatype: 'email-message' } },
    };
    const v = evaluateGoalWindDownOutputs({
      outputSchema: schema,
      outputs: { msg: { subject: 42 } },
      disposition: 'achieved',
      datatypeSchemas: {
        'email-message': {
          type: 'object',
          required: ['subject'],
          properties: { subject: { type: 'string' } },
        },
      },
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('datatype_mismatch');
  });

  it('killed with no outputs is ok — an abandoned goal need not have produced', () => {
    expect(
      evaluateGoalWindDownOutputs({ outputSchema, outputs: null, disposition: 'killed' }),
    ).toEqual({ ok: true, outputs: null });
  });

  it('killed accepts a PARTIAL product (top-level required not demanded)', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema,
      outputs: { count: 2 },
      disposition: 'killed',
    });
    expect(v).toEqual({ ok: true, outputs: { count: 2 } });
  });

  it('killed still refuses an INVALID partial — recorded outputs stay honest', () => {
    const v = evaluateGoalWindDownOutputs({
      outputSchema,
      outputs: { count: 'wrong-type' },
      disposition: 'killed',
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.code).toBe('invalid_outputs');
  });

  it('an uncompilable declared schema refuses for achieved AND killed (fail-closed)', () => {
    const broken = { type: 'object', properties: 'nonsense' };
    const a = evaluateGoalWindDownOutputs({
      outputSchema: broken,
      outputs: { x: 1 },
      disposition: 'achieved',
    });
    expect(a.ok).toBe(false);
    if (a.ok) throw new Error('unreachable');
    expect(a.code).toBe('bad_schema');
    const k = evaluateGoalWindDownOutputs({
      outputSchema: broken,
      outputs: { x: 1 },
      disposition: 'killed',
    });
    expect(k.ok).toBe(false);
    if (k.ok) throw new Error('unreachable');
    expect(k.code).toBe('bad_schema');
  });
});
