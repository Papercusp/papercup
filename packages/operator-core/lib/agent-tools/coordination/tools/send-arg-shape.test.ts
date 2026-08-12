/**
 * send-arg-shape.test.ts — WI-6522: coord:send's REFUSAL TEXT, pinned.
 *
 * This file tests the arg SCHEMA (`sendTool.args.safeParse`), not the handler —
 * send.test.ts covers the handler with the engine mocked. Nothing here does IO.
 *
 * WHY THIS EXISTS. Measured over 14 days (harness_shared.tool_invocations,
 * tool_name='coord:send'): 5,086 ok vs 578 non-ok, and 530 of those 578 (92%)
 * were TWO refusal messages that did not tell the caller what to fix:
 *
 *   334 refusals / 135 distinct senders — one generic bulk-vs-single menu emitted
 *       for every distinct single-send mistake (missing `to`, missing `summary`,
 *       empty `summary`), masking the specific per-field errors that toArg and
 *       summaryArg ALREADY carried.
 *   196 refusals /  80 distinct senders — a bare zod "Invalid input" from `wake`'s
 *       union, naming neither the booleans nor 'required'/'optimistic'.
 *
 * A rejected send is a DROPPED MESSAGE — the caller is an agent mid-turn and most
 * do not retry a validation error — so this is silent coordination loss, not a
 * logged nuisance. The fix changes NO accepted shape: every call that parsed
 * before still parses (the non-regression block at the bottom pins that). Only the
 * text a REFUSAL carries changed.
 *
 * ⚠ THE LOAD-BEARING PIN IS `preserves EI-7838 precedence`. The {to,summary} check
 * lives in a z.preprocess, NOT a trailing .refine(), because zod short-circuits a
 * refine when a sibling field also fails — the older defect where a missing
 * `summary` went unreported and the caller was misdirected to "wake: Invalid
 * input". If someone later moves this check back onto the object, that one test
 * goes red. Do not delete it to make a refactor pass.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/tools/send-arg-shape.test.ts
 */
import { describe, expect, it } from 'vitest';

import sendTool, { itemSpec } from './send';

describe('EI-20223353810864057 — primary coord:send guidance names required summary', () => {
  it('describes summary as the required inbox headline on both guidance surfaces', () => {
    const description = String((sendTool as { description?: unknown }).description ?? '');
    const when = String(
      ((sendTool as { guidance?: { when?: unknown } }).guidance?.when ?? ''),
    );

    for (const text of [description, when]) {
      expect(text).toMatch(/summary[^.]{0,100}required/i);
      expect(text).toMatch(/inbox headline/i);
    }
  });
});

/** Every issue message from a failed parse, joined — order-independent matching. */
function refusal(args: unknown): string {
  const r = sendTool.args.safeParse(args);
  if (r.success) throw new Error(`expected a refusal, but the args parsed: ${JSON.stringify(args)}`);
  return r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' | ');
}

/** The dotted paths zod attributed the issues to. */
function paths(args: unknown): string[] {
  const r = sendTool.args.safeParse(args);
  if (r.success) throw new Error(`expected a refusal, but the args parsed: ${JSON.stringify(args)}`);
  return r.error.issues.map((i) => i.path.join('.'));
}

describe('WI-6522 — `wake` names its accepted values instead of "Invalid input"', () => {
  // The exact string logged 196 times across 80 senders. If this reappears, the
  // custom error on wakeArg's union has been dropped.
  it.each([['true'], ['yes'], ['Required'], ['REQUIRED'], [1], [{}]])(
    'wake=%p is refused with the accepted values named, never a bare "Invalid input"',
    (bad) => {
      const msg = refusal({ to: ['peer'], summary: 'hi', expects: 'none', wake: bad });
      expect(msg).not.toMatch(/^wake: Invalid input$/);
      expect(msg).toMatch(/required/);
      expect(msg).toMatch(/optimistic/);
    },
  );

  it('calls out the string "true" specifically — the most likely mistake, previously indistinguishable', () => {
    expect(refusal({ to: ['peer'], summary: 'hi', expects: 'none', wake: 'true' })).toMatch(
      /STRING "true" is NOT the boolean true/,
    );
  });

  it('still ACCEPTS every valid form — the fix is text-only, the shape is unchanged', () => {
    for (const good of [true, false, 'required', 'optimistic', undefined]) {
      const r = sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none', wake: good });
      expect(r.success, `wake=${JSON.stringify(good)} must still parse`).toBe(true);
    }
  });
});

describe('WI-6522 — a single-send refusal names the FIELD, not the bulk-vs-single menu', () => {
  it('missing `summary` (with `to` present) is reported ON summary, in summaryArg wording', () => {
    const args = { to: ['peer'], expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).toMatch(/needs `summary`/);
    // the old generic menu must NOT be what this caller is handed
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });

  it('an EMPTY-STRING summary is the same mistake and gets the same specific answer', () => {
    const args = { to: ['peer'], summary: '', expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).toMatch(/needs `summary`/);
  });

  it('missing `to` (with `summary` present) is reported ON to', () => {
    const args = { summary: 'hi', expects: 'none' };
    expect(paths(args)).toContain('to');
    expect(refusal(args)).toMatch(/needs `to`/);
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });

  it('an EMPTY `to` array is the same mistake as a missing one', () => {
    const args = { to: [], summary: 'hi', expects: 'none' };
    expect(paths(args)).toContain('to');
  });

  it('`items: []` says the array is empty rather than the generic menu', () => {
    const args = { items: [] };
    expect(paths(args)).toContain('items');
    expect(refusal(args)).toMatch(/EMPTY array/);
  });

  it('a call with NOTHING addressed still gets the bulk-vs-single menu — the genuinely ambiguous case', () => {
    expect(refusal({})).toMatch(/for many distinct messages/);
  });
});

describe('WI-6522 — `body` passed instead of `summary` is named explicitly', () => {
  // Two fresh instances inside ten minutes from two different agents on
  // 2026-07-27 — `body` reads as the obvious field name, and the old refusal
  // never said "summary is missing".
  it('{ to, body } tells the caller body does not satisfy summary', () => {
    const msg = refusal({ to: ['peer'], body: 'the long form text', expects: 'none' });
    expect(msg).toMatch(/needs `summary`/);
    expect(msg).toMatch(/`body`/);
    expect(msg).toMatch(/does NOT satisfy `summary`/);
  });

  it('the same hint rides along on the ambiguous menu when body is the only content given', () => {
    expect(refusal({ body: 'text', expects: 'none' })).toMatch(/does NOT satisfy `summary`/);
  });

  it('is NOT emitted when body is absent — the hint must not become noise on every refusal', () => {
    expect(refusal({ to: ['peer'], expects: 'none' })).not.toMatch(/`body`/);
  });
});

describe('WI-6522 — the branch fires only for MISSING, never for wrong-typed', () => {
  it('a wrong-typed summary falls through to summaryArg’s own type error, not the missing-field branch', () => {
    // Boolean(5) is true, so this is "present but wrong type" — summaryArg owns it.
    const args = { to: ['peer'], summary: 5, expects: 'none' };
    expect(paths(args)).toContain('summary');
    expect(refusal(args)).not.toMatch(/for many distinct messages/);
  });
});

describe('EI-18887930700345699 — independent omissions are reported TOGETHER, not one per round-trip', () => {
  // The `expects` gate keys on `to` being present, NOT on `summary` having landed:
  // the two omissions are independent, so making the second wait for the first to be
  // fixed cost a whole round-trip (and a re-send of the entire body) to learn a fact
  // the validator already knew. coord:send is a DEFERRED tool, so a first-time caller
  // has no schema in context and discovers the envelope purely from these errors.
  it('a call missing BOTH summary and expects names both in ONE refusal', () => {
    const args = { to: ['peer'], body: 'some long body' };
    expect(paths(args)).toContain('summary');
    expect(paths(args)).toContain('expects');
  });

  it('still names expects when only expects is missing', () => {
    expect(paths({ to: ['peer'], summary: 's' })).toContain('expects');
  });

  it('does NOT demand expects when there is no single-send to attach it to', () => {
    // No `to` and no `items` — the caller gets the bulk-vs-single menu, and adding a
    // second complaint about `expects` here would be noise about a message shape they
    // have not chosen yet.
    expect(paths({ summary: 's' })).not.toContain('expects');
  });

  it('does NOT demand expects on an items[]-only call (itemSpec owns that axis)', () => {
    const r = sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 's', expects: 'none' }] });
    expect(r.success).toBe(true);
  });
});

describe('WI-6522 — regression pins that must not be traded away', () => {
  it('preserves EI-7838 precedence: a missing `summary` is STILL reported when `wake` also fails', () => {
    // This is the whole reason the check lives in a z.preprocess. A trailing
    // .refine() is short-circuited by the sibling `wake` failure, which would send
    // the caller chasing "wake: Invalid input" while the real, actionable problem
    // (no summary) went unreported. If this goes red, the check was moved.
    const msg = refusal({ to: ['peer'], expects: 'none', wake: 'true' });
    expect(msg).toMatch(/needs `summary`/);
  });

  it('`expects` is still REQUIRED for the single form, with its four values named (D-016/D-048)', () => {
    const msg = refusal({ to: ['peer'], summary: 'hi' });
    expect(paths({ to: ['peer'], summary: 'hi' })).toContain('expects');
    for (const v of ['ack', 'answer', 'action', 'none']) expect(msg).toMatch(new RegExp(`'${v}'`));
  });

  it('a fully-valid single send parses — the accepted shape is unchanged', () => {
    expect(
      sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none' }).success,
    ).toBe(true);
  });

  it('a fully-valid items[] send parses, and needs no top-level to/summary/expects', () => {
    expect(
      sendTool.args.safeParse({ items: [{ to: ['peer'], summary: 'hi', expects: 'none' }] }).success,
    ).toBe(true);
  });

  // P-013 — expectEffect. The schema is the ONLY place an uninterpretable expectation
  // can be stopped: once stamped on the envelope it is read back by a probe that must
  // either produce a verdict or skip the row, and a silently-skipped expectation is
  // indistinguishable from "the leader never asked".
  describe('expectEffect (P-013)', () => {
    const base = { to: ['peer'], summary: 'hi', expects: 'action' as const, body: [{ text: 'x', forYouBecause: { relation: 'other', note: 'y' } }] };

    it('accepts each declared effect kind on the single form', () => {
      for (const kind of ['checkpoint', 'claim-release', 'terminal']) {
        expect(sendTool.args.safeParse({ ...base, expectEffect: { kind, itemId: 'WI-1' } }).success).toBe(true);
      }
    });

    it('accepts it on an items[] entry too — the two axes must not diverge', () => {
      expect(
        sendTool.args.safeParse({
          items: [{ ...base, expectEffect: { kind: 'checkpoint', itemId: 'WI-1' } }],
        }).success,
      ).toBe(true);
    });

    it('REFUSES an unrecognised kind', () => {
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'lock-taken', itemId: 'WI-1' } }).success).toBe(false);
    });

    it('REFUSES a missing or empty itemId — an effect with no subject is unverifiable', () => {
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint' } }).success).toBe(false);
      expect(sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint', itemId: '' } }).success).toBe(false);
    });

    it('REFUSES an unknown key (.strict) rather than silently ignoring it', () => {
      expect(
        sendTool.args.safeParse({ ...base, expectEffect: { kind: 'checkpoint', itemId: 'WI-1', by: 'soon' } }).success,
      ).toBe(false);
    });

    it('stays entirely OPTIONAL — every existing send shape is unaffected', () => {
      expect(sendTool.args.safeParse({ to: ['peer'], summary: 'hi', expects: 'none' }).success).toBe(true);
    });
  });
});

/**
 * EI-19295149246007753 — field-name PARITY between the items[] axis (`itemSpec`,
 * the canonical field set) and the top-level single-form object schema.
 *
 * The single form used to be built from a hand-listed ~30-field object literal,
 * independent of `itemSpec` — a field added to itemSpec but forgotten there
 * validated fine (ok:true) and then silently vanished before sendOne ever saw
 * it. That mapping was fixed structurally: the single-form SendMsg is now
 * derived by copying itemSpec's own field names off `args` (see send.ts's
 * EI-19295149246007753 comment), so a value-level drop can no longer happen
 * for a field the top-level SCHEMA actually declares.
 *
 * The residual risk this test guards: a field added to `itemSpec` but never
 * mirrored onto the top-level object schema below it. zod strips unrecognised
 * top-level keys by DEFAULT (no error), so such a field would still validate on
 * items[], while a single-form caller's value is stripped before the handler
 * — or even the field-copy loop above — ever runs. This asserts every itemSpec
 * key is also a top-level schema key, at the SCHEMA level (`.def.out.shape`,
 * zod v4's introspectable inner object of the `z.preprocess` wrapper) rather
 * than by re-auditing a hand-kept list, so a forgotten mirror reds this test
 * instead of shipping a silent drop.
 */
describe('EI-19295149246007753 — single-form schema mirrors every itemSpec field', () => {
  it('every itemSpec key is ALSO declared on the top-level (single-form) object schema', () => {
    const itemKeys = Object.keys(itemSpec.shape).sort();
    const topLevelShape = (sendTool.args as unknown as { def: { out: { shape: Record<string, unknown> } } }).def.out
      .shape;
    const topLevelKeys = Object.keys(topLevelShape);
    const missing = itemKeys.filter((k) => !topLevelKeys.includes(k));
    expect(
      missing,
      `itemSpec field(s) ${JSON.stringify(missing)} are NOT declared on the top-level single-form schema — ` +
        'a single-form caller passing this field has it silently stripped by zod before the handler runs. ' +
        'Add it to the z.object({...}) literal alongside the other …Arg fields in send.ts.',
    ).toEqual([]);
  });

  it('sanity: itemSpec is non-trivial (guards the introspection path itself from silently matching an empty set)', () => {
    expect(Object.keys(itemSpec.shape).length).toBeGreaterThan(10);
  });
});
