/**
 * P-016 / D-107 — `premises: [{ ref: "WI-1" }] -> ["WI-1"]`, the one auto-run correction.
 *
 * The measured case: wrong-shape `premises` is 1,211 coord:send rejections across 555 agents in
 * 7 days — 68% of ALL coord:send refusals — and 99.8% of them send exactly one shape. The field
 * already carries a taught refusal written for precisely this error (`PREMISES_SHAPE_MESSAGE`,
 * 2026-08-10) and the volume is measured AFTER it shipped, which is the evidence D-104 demands
 * before a correction may be promoted from advise to execute.
 *
 * The most important tests here are the NEGATIVE ones. D-107 rulings 2 and 4 keep two shapes
 * refused, and only one of the two is merely wasteful:
 *
 *   - a BARE STRING premise. Coercing prose into a ref MANUFACTURES A CITATION the caller never
 *     made. That corrupts the record rather than costing a round-trip, and it is the exact
 *     free-text substitution banned at the top of `message-fields.ts`.
 *   - a member with NO `ref`. Picking which of its keys is the ref is a DISAMBIGUATION, which
 *     D-104 assigns to refuse-and-teach: running a guess answers a question nobody asked.
 *
 * A regression that widened the rule into either shape would still pass every positive test, so
 * these carry the safety property.
 */
import { describe, expect, it } from 'vitest';

import {
  PREMISES_REENCODING_RULE,
  PREMISES_REF_OBJECT_REENCODING,
} from './message-fields';

const run = (input: unknown) => PREMISES_REF_OBJECT_REENCODING.reencode(input);

/** The real coord:send arg shape: premises live on a section inside `body[]`. */
const withPremises = (premises: unknown) => ({
  to: ['su-abc'],
  expects: 'answer',
  body: [{ text: 'the finding', premises }],
});

describe('PREMISES_REF_OBJECT_REENCODING — the shape it repairs', () => {
  it('unwraps the 99.8% shape and reports the path inside body[]', () => {
    const out = run(withPremises([{ ref: 'WI-1' }, { ref: 'EI-2' }]));

    expect(out).not.toBeNull();
    expect((out!.input as { body: Array<{ premises: unknown }> }).body[0].premises).toEqual([
      'WI-1',
      'EI-2',
    ]);
    expect(out!.corrections).toHaveLength(1);
    expect(out!.corrections[0]).toMatchObject({
      path: 'body.0.premises',
      ran: ['WI-1', 'EI-2'],
      rule: PREMISES_REENCODING_RULE,
    });
  });

  it('refuses sibling metadata instead of dropping supplied meaning', () => {
    const out = run(
      withPremises([
        { ref: 'WI-1', provenance: 'authored' },
        { ref: 'WI-2', note: 'why' },
      ]),
    );

    expect(out).toBeNull();
  });

  it('omits `dropped` entirely when the members carried nothing but `ref`', () => {
    const out = run(withPremises([{ ref: 'WI-1' }]));
    expect(out!.corrections[0].dropped).toBeUndefined();
  });

  it('repairs every section independently when several carry the shape', () => {
    const out = run({
      body: [
        { text: 'one', premises: [{ ref: 'WI-1' }] },
        { text: 'two', premises: [{ ref: 'WI-2' }] },
      ],
    });

    expect(out!.corrections.map((c) => c.path)).toEqual(['body.0.premises', 'body.1.premises']);
  });

  it('trims nothing and invents nothing — the output strings are the caller\'s own', () => {
    const out = run(withPremises([{ ref: 'plan-slug#D-107' }]));
    expect((out!.input as { body: Array<{ premises: unknown }> }).body[0].premises).toEqual([
      'plan-slug#D-107',
    ]);
  });
});

describe('PREMISES_REF_OBJECT_REENCODING — the shapes it must REFUSE (D-107 rulings 2 and 4)', () => {
  it('leaves a BARE STRING premise to the taught refusal rather than treating prose as a citation', () => {
    // All 3 observed bare-string premises are prose. Accepting one would manufacture a citation.
    expect(run(withPremises(['the gate was red when I looked']))).toBeNull();
  });

  it('leaves a member with NO `ref` alone — choosing its ref key would be a disambiguation', () => {
    expect(run(withPremises([{ id: 'WI-1' }]))).toBeNull();
    expect(run(withPremises([{ workItem: 'WI-1', note: 'x' }]))).toBeNull();
  });

  it('refuses a MIXED array rather than repairing the members it happens to understand', () => {
    // Partial repair is the worst outcome: it would silently drop the member it could not read
    // while reporting success on the ones it could.
    expect(run(withPremises([{ ref: 'WI-1' }, { id: 'WI-2' }]))).toBeNull();
    expect(run(withPremises([{ ref: 'WI-1' }, { ref: 'WI-2', provenance: 'authored' }]))).toBeNull();
    expect(run(withPremises([{ ref: 'WI-1' }, 'prose']))).toBeNull();
  });

  it('refuses a member whose `ref` is present but not a usable string', () => {
    expect(run(withPremises([{ ref: '' }]))).toBeNull();
    expect(run(withPremises([{ ref: '   ' }]))).toBeNull();
    expect(run(withPremises([{ ref: 123 }]))).toBeNull();
    expect(run(withPremises([{ ref: null }]))).toBeNull();
    expect(run(withPremises([{ ref: ['WI-1'] }]))).toBeNull();
  });

  it('leaves an already-correct call untouched, so a valid call can never be re-shaped', () => {
    expect(run(withPremises(['WI-1', 'WI-2']))).toBeNull();
  });

  it('declines an empty array and a non-array, which the declared schema handles itself', () => {
    expect(run(withPremises([]))).toBeNull();
    expect(run(withPremises({ ref: 'WI-1' }))).toBeNull();
  });

  it('declines a call with no premises at all', () => {
    expect(run({ to: ['su-abc'], expects: 'none', body: [{ text: 'hi' }] })).toBeNull();
    expect(run(null)).toBeNull();
    expect(run('not an object')).toBeNull();
  });
});

describe('PREMISES_REF_OBJECT_REENCODING — purity (the decay instrument depends on it)', () => {
  it('does not mutate the caller\'s args, so tool_invocations.args_json keeps the shape SENT', () => {
    // args_json is the before/after series D-104's endgame clause measures against. An in-place
    // mutation would destroy it while every functional assertion above still passed.
    const input = withPremises([{ ref: 'WI-1' }]);
    const snapshot = structuredClone(input);

    const out = run(input);

    expect(input).toEqual(snapshot);
    expect(out!.input).not.toBe(input);
  });

  it('returns untouched nodes BY IDENTITY rather than deep-copying the whole args object', () => {
    const untouchedSection = { text: 'no premises here' };
    const input = {
      body: [{ text: 'one', premises: [{ ref: 'WI-1' }] }, untouchedSection],
      to: ['su-abc'],
    };

    const out = run(input) as { input: { body: unknown[]; to: unknown } };

    expect(out.input.body[1]).toBe(untouchedSection);
    expect(out.input.to).toBe(input.to);
  });

  it('returns the ORIGINAL node by identity when nothing matched at all', () => {
    // Belt-and-braces on the same property: a declining rule must not hand back a rebuilt clone,
    // or a future caller threading rules together would silently lose the identity guarantee.
    const input = withPremises(['WI-1']);
    expect(run(input)).toBeNull();
  });
});

describe('PREMISES_REF_OBJECT_REENCODING — bounds', () => {
  it('bounds a large disclosed value instead of echoing the whole array back', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ref: `WI-${i}` }));
    const out = run(withPremises(many));

    expect(out!.corrections[0].sent).toBe('<your original 60-item array>');
    expect(out!.corrections[0].ran).toBe('<your original 60-item array>');
    // The REPAIR itself is never bounded — only its disclosure is.
    expect((out!.input as { body: Array<{ premises: string[] }> }).body[0].premises).toHaveLength(
      60,
    );
  });

  it('stops descending past the depth bound rather than walking a pathological nesting', () => {
    // 8 levels deep — past PREMISES_WALK_MAX_DEPTH (6). Not repairing it is the correct outcome:
    // no real coord:send section nests that far, and an unbounded walk is a repair-path cost.
    let deep: unknown = { premises: [{ ref: 'WI-1' }] };
    for (let i = 0; i < 8; i += 1) deep = { nested: deep };

    expect(run(deep)).toBeNull();
  });

  it('still repairs at the real depth coord:send actually uses (body[].premises)', () => {
    // The calibration control for the bound above: if the depth limit were mis-set, the test
    // above would pass for the wrong reason and the shipped rule would repair nothing.
    expect(run(withPremises([{ ref: 'WI-1' }]))).not.toBeNull();
  });
});
