/**
 * message-fields.test.ts — the ratified semantics of the authored message
 * fields (unified-agent-state-plane-2026-07-27 P-032, reopened by D-070).
 *
 * These tests assert the RULINGS, not the plumbing: the envelope/section split
 * (D-064), `'other'` requiring a note and being excluded from the divergence
 * check (D-043), and D-026's "any ref may be cited; the KIND decides staleness".
 */

import { describe, it, expect } from 'vitest';
import {
  classifyPremiseRef,
  participatesInCouplingDivergence,
  assertEnvelopeSectionSplit,
  EnvelopeFieldOnSectionError,
  messageSectionSchema,
  stampMessageFields,
  toSections,
  sectionsToText,
  ENVELOPE_ONLY_FIELDS,
} from './message-fields';

describe('premise ref classification (D-026)', () => {
  it('classifies each admissible ref kind', () => {
    expect(classifyPremiseRef('fact:owner:su-709bb:gate-reds-unrelated@v7').kind).toBe('fact');
    expect(classifyPremiseRef('unified-agent-state-plane-2026-07-27#D-023').kind).toBe('plan-decision');
    expect(classifyPremiseRef('WI-6199#completion').kind).toBe('work-item-completion');
    expect(classifyPremiseRef('msg:ms2ipk0d-0000-abc').kind).toBe('peer-message');
    expect(classifyPremiseRef('owner-turn:2026-07-27').kind).toBe('owner-directive');
    expect(classifyPremiseRef('/internal/docs/agent-insights/reading-pipeline-state').kind).toBe('doc');
  });

  it('cites the WORK-ITEM COMPLETION CLAIM, not the bare item (D-026 correction 2)', () => {
    expect(classifyPremiseRef('WI-6199#completion').kind).toBe('work-item-completion');
    // A bare item id is not a claim — it degrades to opaque rather than being
    // silently upgraded into an invalidatable completion assertion.
    expect(classifyPremiseRef('WI-6199').kind).toBe('opaque');
  });

  it('NEVER excludes an unrecognised ref — it degrades to opaque (the governing rule)', () => {
    const odd = classifyPremiseRef('something nobody anticipated');
    expect(odd.kind).toBe('opaque');
    expect(odd.ref).toBe('something nobody anticipated');
    expect(odd.invalidatable).toBe(false);
  });

  it('the ref KIND determines invalidatability, not the citation site', () => {
    for (const ref of [
      'fact:owner:su-1:k@v1',
      'plan-x#D-001',
      'WI-1#completion',
      'msg:abc',
      'owner-turn:x',
    ]) {
      expect(classifyPremiseRef(ref).invalidatable).toBe(true);
    }
    // Declarable, but nothing can make them go stale.
    expect(classifyPremiseRef('/internal/docs/x').invalidatable).toBe(false);
    expect(classifyPremiseRef('freeform').invalidatable).toBe(false);
  });

  it('a prefixed ref never falls through to the plan-decision arm', () => {
    expect(classifyPremiseRef('msg:thread#D-001').kind).toBe('peer-message');
    expect(classifyPremiseRef('owner-turn:ruling#D-002').kind).toBe('owner-directive');
  });
});

describe('forYouBecause (D-043)', () => {
  it("REFUSES relation:'other' without a note", () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'hi',
      forYouBecause: { relation: 'other' },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/D-043/);
  });

  it("accepts relation:'other' WITH a note", () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'hi',
        forYouBecause: { relation: 'other', note: 'you wrote the lint this refactor trips' },
      }).success,
    ).toBe(true);
  });

  it('accepts a structural relation without a note', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'hi',
        forYouBecause: { relation: 'holds-a-lock-on', ref: 'packages/x/y.ts' },
      }).success,
    ).toBe(true);
  });

  it("EXCLUDES 'other' from the asserted-vs-computed divergence check, by construction", () => {
    // The load-bearing half of D-043: an 'other' that participated in the diff
    // would reintroduce the false-agreement failure the escape hatch prevents.
    expect(participatesInCouplingDivergence({ relation: 'other', note: 'n' })).toBe(false);
    expect(participatesInCouplingDivergence({ relation: 'owns' })).toBe(true);
    expect(participatesInCouplingDivergence({ relation: 'same-fleet' })).toBe(true);
  });
});

describe('the envelope/section split (D-064) — enforced, not documented', () => {
  it.each(ENVELOPE_ONLY_FIELDS)('refuses envelope field %s on a section', (field) => {
    expect(() => assertEnvelopeSectionSplit([{ text: 'a' }, { text: 'b', [field]: 'x' }])).toThrow(
      EnvelopeFieldOnSectionError,
    );
  });

  it('names the offending index and teaches the rule', () => {
    try {
      assertEnvelopeSectionSplit([{ text: 'a' }, { text: 'b', blocking: true }]);
      expect.unreachable('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeFieldOnSectionError);
      expect((e as EnvelopeFieldOnSectionError).code).toBe('coord_envelope_field_on_section');
      expect((e as Error).message).toContain('body[1].blocking');
      expect((e as Error).message).toMatch(/scheduler acts on a message as a UNIT/);
    }
  });

  it('allows all four SECTION fields on a section', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'the gate red is mine and already fixed',
        premises: ['WI-6199#completion', '/internal/docs/x'],
        forYouBecause: { relation: 'is-blocked-on', ref: 'gate' },
        youMayNotKnow: [{ ref: 'fact:owner:su-1:k@v2', provenance: 'computed' }],
        couldNotDetermine: [{ what: 'whether the next candidate carries the fix' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown key outright (strict)', () => {
    expect(messageSectionSchema.safeParse({ text: 'a', vibes: 'good' }).success).toBe(false);
  });
});

describe('body normalisation (D-064 n=1)', () => {
  it('a plain string is the one-element array', () => {
    expect(toSections('hello')).toEqual([{ text: 'hello' }]);
  });

  it('empty/undefined bodies carry no sections', () => {
    expect(toSections(undefined)).toEqual([]);
    expect(toSections('')).toEqual([]);
  });

  it('round-trips section text for the readers that render plain body', () => {
    expect(sectionsToText([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
  });
});

describe('stampMessageFields', () => {
  it('leaves a plain-string send byte-identical on the wire (the n=1 case costs nothing)', () => {
    expect(stampMessageFields({ body: 'just prose' })).toEqual({});
  });

  it('stamps sections once they actually CARRY something', () => {
    const stamp = stampMessageFields({
      body: [{ text: 'a', premises: ['unified-agent-state-plane-2026-07-27#D-070'] }],
    });
    expect(stamp.sections).toHaveLength(1);
    expect(stamp.premisesClassified?.[0]?.[0]).toEqual({
      ref: 'unified-agent-state-plane-2026-07-27#D-070',
      kind: 'plan-decision',
      invalidatable: true,
    });
  });

  it('stamps multi-section bodies even when no authored field is set', () => {
    expect(stampMessageFields({ body: [{ text: 'a' }, { text: 'b' }] }).sections).toHaveLength(2);
  });

  it('classifies premises AT SEND TIME so no reader re-derives D-026', () => {
    const stamp = stampMessageFields({
      body: [{ text: 'a', premises: ['/internal/docs/x', 'msg:abc'] }],
    });
    expect(stamp.premisesClassified?.[0]?.map((p) => p.invalidatable)).toEqual([false, true]);
  });

  it('carries the envelope fields through unchanged', () => {
    const stamp = stampMessageFields({
      body: 'x',
      why: { goalRef: 'unified-agent-state-plane-2026-07-27#P-032', note: 'owner directive' },
      blocking: false,
    });
    expect(stamp.why?.goalRef).toBe('unified-agent-state-plane-2026-07-27#P-032');
    expect(stamp.blocking).toBe(false);
  });
});
