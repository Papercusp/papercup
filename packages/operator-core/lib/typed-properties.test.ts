/**
 * typed-properties.test.ts — the pure typed-property core
 * (work-on-everything-goal-2026-08-23 P-023 / WI-41047).
 *
 * Pins prepareTypedPropertyMutation (CAS incl. 0-means-unset, editable_by
 * authorization, unknown property, injected datatype validation, envelope
 * build + prior-value fallback to the declaration default) and
 * renderPropertyDelta (the orient-fold delta line).
 */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { PrepareTypedPropertyMutationArgs } from './typed-properties';

// Copy-out falsifiability probes exercise the unchanged suite against a relocated
// subject. Ordinary CI always uses the real module; no in-tree mutation is needed.
const { prepareTypedPropertyMutation, renderPropertyDelta }: typeof import('./typed-properties') =
  process.env.PAPERCUSP_TYPED_PROPERTY_PROBE
    ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_TYPED_PROPERTY_PROBE).href)
    : await import('./typed-properties');

const SCHEMA = {
  worklist: { datatype: 'string-list', default: ['perf'], editable_by: 'both' },
  budget: { datatype: 'usd', editable_by: 'owner' },
  notes: { datatype: 'prose', editable_by: 'agent' },
} as const;

const okValidate: PrepareTypedPropertyMutationArgs['validate'] = () => ({ ok: true });

const base = (over: Partial<PrepareTypedPropertyMutationArgs>): PrepareTypedPropertyMutationArgs => ({
  propertySchema: SCHEMA,
  properties: {},
  property: 'worklist',
  value: ['docs sweeps'],
  expectedVersion: 0,
  provenance: 'owner-edit',
  actorId: 'avi',
  validate: okValidate,
  ...over,
});

describe('P-023: prepareTypedPropertyMutation', () => {
  it('bad_property_schema on a malformed declaration document', () => {
    const r = prepareTypedPropertyMutation(base({ propertySchema: { 'BAD NAME': { datatype: 'x', editable_by: 'both' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_property_schema');
  });

  it('bad_properties on a malformed stored document', () => {
    const r = prepareTypedPropertyMutation(base({ properties: { worklist: { value: 1 } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_properties');
  });

  it('unknown_property when the name is not declared', () => {
    const r = prepareTypedPropertyMutation(base({ property: 'nope' }));
    expect(r).toMatchObject({ ok: false, code: 'unknown_property', property: 'nope' });
  });

  it('forbidden: an agent-edit on an owner-only property (and vice versa)', () => {
    const agentOnOwner = prepareTypedPropertyMutation(
      base({ property: 'budget', provenance: 'agent-edit', value: 5 }),
    );
    expect(agentOnOwner).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });
    const ownerOnAgent = prepareTypedPropertyMutation(
      base({ property: 'notes', provenance: 'owner-edit', value: 'x' }),
    );
    expect(ownerOnAgent).toMatchObject({ ok: false, code: 'forbidden', editableBy: 'agent' });
  });

  it('stale: expectedVersion must match (0 = unset)', () => {
    // Unset property, caller claims version 3 → stale with actual 0.
    const claimed = prepareTypedPropertyMutation(base({ expectedVersion: 3 }));
    expect(claimed).toMatchObject({ ok: false, code: 'stale', expectedVersion: 3, actualVersion: 0 });
    // Set property at version 2, caller claims 1 → stale with actual 2.
    const stored = {
      worklist: {
        value: ['perf'],
        version: 2,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit',
      },
    };
    const behind = prepareTypedPropertyMutation(base({ properties: stored, expectedVersion: 1 }));
    expect(behind).toMatchObject({ ok: false, code: 'stale', expectedVersion: 1, actualVersion: 2 });
  });

  it('invalid_value carries the injected validator issues + the datatype ref', () => {
    const r = prepareTypedPropertyMutation(
      base({ validate: () => ({ ok: false, issues: ['/0 must be string'] }) }),
    );
    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_value',
      datatype: 'string-list',
      issues: ['/0 must be string'],
    });
  });

  it('blocks an array-length reduction unless the caller explicitly confirms the shrink', () => {
    const stored = {
      worklist: {
        value: ['first', 'second', 'third'],
        version: 4,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit' as const,
      },
    };

    const blocked = prepareTypedPropertyMutation(
      base({ properties: stored, expectedVersion: 4, value: ['first'] }),
    );
    expect(blocked).toEqual({
      ok: false,
      code: 'shrink_blocked',
      property: 'worklist',
      priorLength: 3,
      proposedLength: 1,
      actualVersion: 4,
      recovery: { confirmShrink: true },
    });

    const confirmed = prepareTypedPropertyMutation(
      base({
        properties: stored,
        expectedVersion: 4,
        value: ['first'],
        confirmShrink: true,
      }),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.value).toEqual(['first']);
    expect(confirmed.entry.version).toBe(5);
  });

  it('does not treat array growth, same-length replacement, or scalar writes as shrink', () => {
    const worklist = {
      value: ['first', 'second'],
      version: 2,
      edited_at: new Date().toISOString(),
      edited_by: 'avi',
      provenance: 'owner-edit' as const,
    };
    for (const value of [
      ['replacement', 'same-length'],
      ['first', 'second', 'third'],
    ]) {
      expect(
        prepareTypedPropertyMutation(
          base({ properties: { worklist }, expectedVersion: 2, value }),
        ).ok,
      ).toBe(true);
    }

    expect(
      prepareTypedPropertyMutation(
        base({ property: 'notes', value: 'short', provenance: 'agent-edit' }),
      ).ok,
    ).toBe(true);
  });

  it('reports stale before shrink_blocked when the caller version is not current', () => {
    const stored = {
      worklist: {
        value: ['first', 'second'],
        version: 3,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit' as const,
      },
    };
    expect(
      prepareTypedPropertyMutation(
        base({ properties: stored, expectedVersion: 2, value: [] }),
      ),
    ).toMatchObject({ ok: false, code: 'stale', actualVersion: 3 });
  });

  it('ok: envelope build — version bump, provenance + actor stamp, merged document', () => {
    const r = prepareTypedPropertyMutation(base({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.version).toBe(1);
    expect(r.entry.provenance).toBe('owner-edit');
    expect(r.entry.edited_by).toBe('avi');
    expect(r.entry.value).toEqual(['docs sweeps']);
    // priorValue falls back to the DECLARATION default when unset.
    expect(r.priorValue).toEqual(['perf']);
    expect(r.priorVersion).toBe(0);
    expect(r.properties.worklist).toBe(r.entry);
  });

  it('ok: a second write increments the stored version and reports the stored prior', () => {
    const first = prepareTypedPropertyMutation(base({}));
    if (!first.ok) throw new Error('first write refused');
    const second = prepareTypedPropertyMutation(
      base({
        properties: first.properties,
        expectedVersion: 1,
        value: ['docs sweeps', 'gate triage'],
        provenance: 'agent-edit',
        actorId: 'su-1',
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.version).toBe(2);
    expect(second.priorValue).toEqual(['docs sweeps']);
    expect(second.entry.provenance).toBe('agent-edit');
  });
});

describe('P-023: renderPropertyDelta', () => {
  it('scalar-array diff renders +added −removed', () => {
    expect(renderPropertyDelta('worklist', ['perf'], ['docs sweeps'])).toBe(
      'worklist: +"docs sweeps" −"perf"',
    );
  });

  it('unset prior array renders additions only', () => {
    expect(renderPropertyDelta('worklist', undefined, ['a'])).toBe('worklist: +"a"');
  });

  it('identical arrays render unchanged', () => {
    expect(renderPropertyDelta('worklist', ['a'], ['a'])).toBe('worklist: unchanged');
  });

  it('scalars render prior → next, with ∅ for unset', () => {
    expect(renderPropertyDelta('budget', undefined, 500)).toBe('budget: ∅ → 500');
    expect(renderPropertyDelta('budget', 500, 750)).toBe('budget: 500 → 750');
  });

  it('long values are clipped to one line', () => {
    const long = 'x'.repeat(200);
    const line = renderPropertyDelta('notes', undefined, long);
    expect(line.length).toBeLessThan(80);
    expect(line).toContain('…');
  });
});
