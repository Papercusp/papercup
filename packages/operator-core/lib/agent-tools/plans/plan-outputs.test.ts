/**
 * plan-outputs.test.ts — external-triggers-gmail-slack-2026-08-22 P-026 / D-017.
 *
 * Pins the two pure cores behind a plan's declared outputs: which canonical datatypes a
 * schema REFERENCES (D-004), and whether a completing run's published values keep the
 * promise the plan made (D-017's fail-loud publication rule).
 */
import { describe, it, expect } from 'vitest';
import { collectDatatypeRefs, evaluatePublishOutputs } from './plan-outputs';

const SCHEMA = {
  type: 'object',
  properties: {
    briefId: { type: 'string' },
    filedIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['briefId', 'filedIds'],
} as Record<string, unknown>;

describe('P-026: collectDatatypeRefs (D-004 canonical shape references)', () => {
  it('finds a top-level property reference', () => {
    expect(
      collectDatatypeRefs({ type: 'object', properties: { msg: { datatype: 'email-message' } } }),
    ).toEqual(['email-message']);
  });

  it('finds references nested in items, $defs and applicator arrays', () => {
    // A reference is legal anywhere a subschema is, and one the walk missed would be
    // silently unvalidated at publish — the exact failure this module exists to prevent.
    const schema = {
      type: 'object',
      properties: {
        thread: { type: 'array', items: { datatype: 'chat-message' } },
        who: { anyOf: [{ datatype: 'contact' }, { type: 'null' }] },
      },
      $defs: { post: { datatype: 'social-post' } },
    };
    expect(collectDatatypeRefs(schema).sort()).toEqual(['chat-message', 'contact', 'social-post']);
  });

  it('dedupes repeats and ignores non-string / blank annotations', () => {
    const schema = {
      properties: {
        a: { datatype: 'email-message' },
        b: { datatype: 'email-message' },
        c: { datatype: '   ' },
        d: { datatype: 42 },
      },
    };
    expect(collectDatatypeRefs(schema)).toEqual(['email-message']);
  });

  it('returns [] for a schema that references nothing, and terminates on a cycle', () => {
    expect(collectDatatypeRefs(SCHEMA)).toEqual([]);
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    expect(collectDatatypeRefs(cyclic)).toEqual([]); // depth bound, not a hang
  });
});

describe('P-026: evaluatePublishOutputs (D-017 publication gate)', () => {
  it('no_outputs_declared when the plan promised nothing', () => {
    // Not a silent no-op: publishing to a plan that declared no outputs is a caller bug.
    expect(evaluatePublishOutputs(null, { anything: 1 })).toEqual({
      ok: false,
      code: 'no_outputs_declared',
    });
  });

  it('ok when every declared output is filled', () => {
    const r = evaluatePublishOutputs(SCHEMA, { briefId: 'b1', filedIds: ['WI-1'] });
    expect(r).toMatchObject({ ok: true });
    expect((r as { keys: string[] }).keys.sort()).toEqual(['briefId', 'filedIds']);
  });

  it('missing_outputs — the D-017 loud failure, naming every unfilled field', () => {
    const r = evaluatePublishOutputs(SCHEMA, { briefId: 'b1' });
    expect(r).toMatchObject({ ok: false, code: 'missing_outputs', missing: ['filedIds'] });
  });

  it('treats an explicit null as UNFILLED, not as a supplied value', () => {
    // `null` is exactly the "silently chaining undefined values" case D-017 names — a
    // downstream deterministic step cannot tell it apart from a real value.
    const r = evaluatePublishOutputs(SCHEMA, { briefId: 'b1', filedIds: null });
    expect(r).toMatchObject({ ok: false, code: 'missing_outputs', missing: ['filedIds'] });
  });

  it('reports MISSING before INVALID when a field is both absent and others are malformed', () => {
    // Order matters for actionability: telling an agent a field is "invalid" when it
    // simply never filled it sends it to inspect a value that does not exist.
    const r = evaluatePublishOutputs(SCHEMA, { filedIds: 'not-an-array' });
    expect(r).toMatchObject({ ok: false, code: 'missing_outputs', missing: ['briefId'] });
  });

  it('invalid_outputs when a filled value does not satisfy the declared schema', () => {
    const r = evaluatePublishOutputs(SCHEMA, { briefId: 'b1', filedIds: 'not-an-array' });
    expect(r).toMatchObject({ ok: false, code: 'invalid_outputs' });
    expect((r as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('bad_schema is FATAL here — never fail-open like validateDatatypePayload', () => {
    // The datatype wrapper maps an uncompilable schema to ok on purpose (a declaration
    // bug must not block instance creation). That policy is wrong at this door: "could
    // not check" must not render as "nothing was promised".
    const r = evaluatePublishOutputs({ type: 'banana' } as Record<string, unknown>, { a: 1 });
    expect(r).toMatchObject({ ok: false, code: 'bad_schema' });
  });

  it('datatype_mismatch — a bound field is held to the CANONICAL shape (D-004)', () => {
    const schema = {
      type: 'object',
      properties: { msg: { type: 'object', datatype: 'email-message' } },
      required: ['msg'],
    } as Record<string, unknown>;
    const canonical = {
      type: 'object',
      properties: { subject: { type: 'string' }, from: { type: 'string' } },
      required: ['subject', 'from'],
    };
    // Satisfies the plan's own loose restatement, but NOT the platform shape.
    const r = evaluatePublishOutputs(schema, { msg: { subject: 'hi' } }, {
      'email-message': canonical,
    });
    expect(r).toMatchObject({ ok: false, code: 'datatype_mismatch', datatype: 'email-message', field: 'msg' });
  });

  it('accepts a bound field that DOES match the canonical shape', () => {
    const schema = {
      type: 'object',
      properties: { msg: { type: 'object', datatype: 'email-message' } },
      required: ['msg'],
    } as Record<string, unknown>;
    const canonical = {
      type: 'object',
      properties: { subject: { type: 'string' }, from: { type: 'string' } },
      required: ['subject', 'from'],
    };
    const r = evaluatePublishOutputs(schema, { msg: { subject: 'hi', from: 'a@b.c' } }, {
      'email-message': canonical,
    });
    expect(r).toMatchObject({ ok: true });
  });

  it('an UNRESOLVED datatype imposes no constraint — absence is not evidence of a mismatch', () => {
    // The declare door already rejects dangling references; an unreadable registry at
    // publish time must not manufacture a failure.
    const schema = {
      type: 'object',
      properties: { msg: { type: 'object', datatype: 'email-message' } },
      required: ['msg'],
    } as Record<string, unknown>;
    const r = evaluatePublishOutputs(schema, { msg: { whatever: true } }, {});
    expect(r).toMatchObject({ ok: true });
  });
});
