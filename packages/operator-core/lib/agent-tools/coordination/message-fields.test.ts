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
  renderAuthoredFieldsSuffix,
  projectAuthoredFields,
} from './message-fields';

describe('renderAuthoredFieldsSuffix — making the fields visible', () => {
  it('renders nothing for an ordinary message (no sections stamped)', () => {
    expect(renderAuthoredFieldsSuffix({ body: 'hi' })).toBe('');
    expect(renderAuthoredFieldsSuffix({ sections: [] })).toBe('');
  });

  it('renders nothing when sections carry no authored fields', () => {
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a' }, { text: 'b' }] })).toBe('');
  });

  it('names a single premise, but COUNTS several (the line shares a ~200-char cap)', () => {
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a', premises: ['WI-1#completion'] }] })).toContain(
      '⊨ WI-1#completion',
    );
    expect(
      renderAuthoredFieldsSuffix({ sections: [{ text: 'a', premises: ['x#D-001', 'y#D-002', 'msg:z'] }] }),
    ).toContain('⊨ 3 premises');
  });

  it('does NOT reuse `⊢` — that glyph already means the evidence band on this line', () => {
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a', premises: ['WI-1#completion'] }] })).not.toContain(
      '⊢',
    );
  });

  it('SPELLS OUT couldNotDetermine — it marks a question OPEN, which is a different action', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [{ text: 'a', couldNotDetermine: [{ what: 'whether the deploy carries the fix' }] }],
    });
    expect(out).toContain('? undetermined: whether the deploy carries the fix');
  });

  it('surfaces blocking and the coupling relation', () => {
    const out = renderAuthoredFieldsSuffix({
      blocking: true,
      sections: [{ text: 'a', forYouBecause: { relation: 'holds-a-lock-on', ref: 'x.ts' } }],
    });
    expect(out).toContain('BLOCKING');
    expect(out).toContain('∵ holds-a-lock-on x.ts');
  });

  it('⚠ SUPPRESSES a DERIVED field (D-072) — a GUI default is not the sender\'s model of you', () => {
    const out = renderAuthoredFieldsSuffix({
      blocking: false,
      sections: [{ text: 'a', forYouBecause: { relation: 'other', note: 'owner addressed you' } }],
      fieldProvenance: { forYouBecause: 'owner-gui-derived', blocking: 'owner-gui-derived' },
    });
    expect(out).toBe('');
  });

  it('still renders the AUTHORED fields of a message whose OTHER fields were derived', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          forYouBecause: { relation: 'other', note: 'derived' },
          couldNotDetermine: [{ what: 'the real question' }],
        },
      ],
      fieldProvenance: { forYouBecause: 'owner-gui-derived' },
    });
    expect(out).not.toContain('∵');
    expect(out).toContain('? undetermined: the real question');
  });
});

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

/**
 * P-033 (e) — the READER projection. `coord:read`, `coord:thread` and the pui pane
 * all showed only the FLATTENED body string, so a field nobody could see could not
 * be judged by its VALUES — the only check D-070 leaves standing.
 */
describe('projectAuthoredFields — making the fields readable', () => {
  /** The exact shape the send path writes onto the envelope. */
  function stamped(input: Parameters<typeof stampMessageFields>[0], rest: Record<string, unknown> = {}) {
    return { ...stampMessageFields(input), ...rest };
  }

  it('returns undefined for a plain message — an ordinary send grows no new block', () => {
    expect(projectAuthoredFields(undefined)).toBeUndefined();
    expect(projectAuthoredFields({})).toBeUndefined();
    expect(projectAuthoredFields(stamped({ body: 'just text' }))).toBeUndefined();
  });

  it('is total on junk — a malformed envelope never throws at a reader', () => {
    expect(projectAuthoredFields(null)).toBeUndefined();
    expect(projectAuthoredFields('nonsense')).toBeUndefined();
    expect(projectAuthoredFields(42)).toBeUndefined();
    expect(projectAuthoredFields({ sections: 'not-an-array' })).toBeUndefined();
  });

  it('surfaces the four SECTION fields per section (D-064)', () => {
    const out = projectAuthoredFields(
      stamped({
        body: [
          {
            text: 'a',
            premises: ['WI-1#completion'],
            forYouBecause: { relation: 'owns', ref: 'P-033' },
            youMayNotKnow: [{ ref: 'D-072', provenance: 'plan-decision' }],
            couldNotDetermine: [{ what: 'whether the deploy landed' }],
          },
          { text: 'b' },
        ],
      }),
    );
    expect(out?.sections).toHaveLength(2);
    expect(out?.sections?.[0]?.forYouBecause?.relation).toBe('owns');
    expect(out?.sections?.[0]?.youMayNotKnow).toHaveLength(1);
    expect(out?.sections?.[0]?.couldNotDetermine?.[0]?.what).toBe('whether the deploy landed');
    // The second section authored nothing — it keeps its text and gains no fields.
    expect(out?.sections?.[1]).toEqual({ text: 'b' });
  });

  it('hands the reader premises ALREADY CLASSIFIED, so nobody re-derives D-026', () => {
    const out = projectAuthoredFields(
      stamped({ body: [{ text: 'a', premises: ['/internal/docs/x', 'msg:abc'] }] }),
    );
    expect(out?.sections?.[0]?.premises?.map((p) => p.invalidatable)).toEqual([false, true]);
    expect(out?.sections?.[0]?.premises?.[0]?.ref).toBe('/internal/docs/x');
  });

  it('classifies on the fly for a message stamped before premisesClassified existed', () => {
    // Back-compat: sections present, classification absent. D-026 forbids dropping a
    // citation for being unrecognised, so it must still come back classified.
    const out = projectAuthoredFields({ sections: [{ text: 'a', premises: ['msg:abc'] }] });
    expect(out?.sections?.[0]?.premises).toEqual([
      { ref: 'msg:abc', kind: 'peer-message', invalidatable: true },
    ]);
  });

  it('surfaces the ENVELOPE fields once, never per section (D-064’s load-bearing half)', () => {
    const out = projectAuthoredFields(
      stamped(
        { body: [{ text: 'a', premises: ['WI-1#x'] }], why: { goalRef: 'plan#P-033' }, blocking: true },
        { expects: 'action' },
      ),
    );
    expect(out?.expects).toBe('action');
    expect(out?.blocking).toBe(true);
    expect(out?.why?.goalRef).toBe('plan#P-033');
    for (const section of out?.sections ?? []) {
      for (const field of ENVELOPE_ONLY_FIELDS) {
        expect(section).not.toHaveProperty(field);
      }
    }
  });

  it('marks DERIVED values so adoption measurement can exclude them (D-072)', () => {
    const out = projectAuthoredFields(
      stamped({ body: [{ text: 'a', premises: ['WI-1#x'] }] }, {
        expects: 'none',
        fieldProvenance: { expects: 'owner-gui-derived' },
      }),
    );
    // The VALUE is still shown — a reader needs it — but it is flagged as not authored.
    expect(out?.expects).toBe('none');
    expect(out?.derivedFields).toContain('expects');
  });

  it('a fully-derived message is still distinguishable from an authored one', () => {
    const authoredMsg = projectAuthoredFields(stamped({ body: 'x' }, { expects: 'action' }));
    const derivedMsg = projectAuthoredFields(
      stamped({ body: 'x' }, { expects: 'action', fieldProvenance: { expects: 'machine-derived' } }),
    );
    expect(authoredMsg?.derivedFields).toBeUndefined();
    expect(derivedMsg?.derivedFields).toEqual(['expects']);
  });
});
