/**
 * plan-inputs-wire.test — plan-structured-inputs-2026-08-01 P-013.
 *
 * The two WIRE-SHAPE facts the inputs panel depends on. Both were found by probing the
 * live route, not by the component tests — which mock the fetcher and the start verb,
 * and so would have stayed green through either bug.
 *
 * 1. `plans:get-input-schema` is a BULK tool: a single-slug call still returns
 *    `{ ok, results: [row], counts }`, and the admin route unwraps that envelope only
 *    for `get`. Reading the envelope as a row yields a row whose every field is
 *    `undefined` — a panel that renders nothing, with no error to notice.
 * 2. A start refusal arrives as a 200 body carrying `error: 'plan_inputs_not_ready'`,
 *    never a thrown HTTP error, so it must be discriminated structurally.
 */
import { describe, it, expect } from 'vitest';
import { isPlanStartRefusal, unwrapPlanInputs } from './plans-api';

const ROW = {
  ok: true,
  slug: 'demo',
  source: 'input-schema',
  inputSchema: { type: 'object', properties: { paths: { type: 'array' } }, required: ['paths'] },
  template: null,
  required: ['paths'],
  missing: ['paths'],
  values: null,
  ready: false,
};

describe('unwrapPlanInputs', () => {
  it('unwraps the single row out of the bulk envelope', () => {
    // The exact shape the live route returned on 2026-08-02.
    expect(unwrapPlanInputs({ ok: true, results: [ROW], counts: { ok: 1, failed: 0 } })).toEqual(ROW);
  });

  it('passes a bare error object through unchanged', () => {
    expect(unwrapPlanInputs({ ok: false, error: 'unknown_verb' })).toEqual({
      ok: false,
      error: 'unknown_verb',
    });
  });

  it('reports not_found for an empty result set rather than returning undefined', () => {
    // Returning results[0] blind would hand the caller `undefined`, which reads as a
    // row with no schema — indistinguishable from a plan that declares none.
    expect(unwrapPlanInputs({ ok: true, results: [], counts: { ok: 0, failed: 1 } })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  it('does not throw on a malformed body', () => {
    expect(unwrapPlanInputs(null)).toEqual({ ok: false, error: 'malformed_response' });
    expect(unwrapPlanInputs('nope')).toEqual({ ok: false, error: 'malformed_response' });
  });
});

describe('isPlanStartRefusal', () => {
  it('recognises the refusal that arrives as a 200 body', () => {
    expect(
      isPlanStartRefusal({
        ok: false,
        error: 'plan_inputs_not_ready',
        code: 'missing_required',
        slug: 'demo',
        missing: ['paths'],
        issues: [],
        source: 'input-schema',
        hint: 'Required input not supplied: paths.',
      }),
    ).toBe(true);
  });

  it('does not mistake a successful start, or another error, for a refusal', () => {
    expect(isPlanStartRefusal({ slug: 'demo', harnessSlug: 'papercusp', status: 'started' })).toBe(
      false,
    );
    expect(isPlanStartRefusal({ error: 'busy' })).toBe(false);
    expect(isPlanStartRefusal(null)).toBe(false);
    expect(isPlanStartRefusal(undefined)).toBe(false);
  });
});
