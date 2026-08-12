/**
 * The one string the editor and the validator BOTH spell (D-015).
 *
 * `launchSettingsOptions` exists so the panel never hand-spells a closed set the
 * server owns (D-011). The unlimited literal is the one value that does not fit
 * that mechanism: it is a wire constant, not a set to enumerate, so shipping it
 * in the payload would be ceremony around a single word — but a single word that
 * is spelled in two packages is exactly what D-011 is about.
 *
 * So it is spelled twice and PINNED here. Rename either side and this fails,
 * instead of the failure it would otherwise produce: the checkbox writes a value
 * the schema rejects, the save fails with a zod message about a union, and the
 * only visible symptom is that "No ceiling" cannot be saved.
 *
 * WHY A COMPARISON AND NOT AN ASSERTION AGAINST A LITERAL. Writing
 * `expect(UNLIMITED).toBe('unlimited')` here would pass while the SERVER moved
 * to something else — it would pin the client to this file's own memory of the
 * value rather than to the authority. The two constants are compared to each
 * other, so neither can drift alone.
 */
import { describe, it, expect } from 'vitest';
import { UNLIMITED_CEILING, goalLaunchSettingsSchema } from '@papercusp/operator-core/lib/goal-launch-settings';
import { UNLIMITED, isUnlimited, ceilingHint } from './goal-launch-settings-model';

describe('the unlimited literal', () => {
  it('is the SAME string on both sides of the wire', () => {
    expect(UNLIMITED).toBe(UNLIMITED_CEILING);
  });

  it('is a value the server schema actually accepts', () => {
    // The stronger claim: not just "the two constants match" but "what the form
    // emits survives the validator". A matching pair that both got renamed to
    // something the schema rejects would pass the test above.
    expect(goalLaunchSettingsSchema.safeParse({ maxAgents: UNLIMITED }).success).toBe(true);
    expect(goalLaunchSettingsSchema.safeParse({ maxPerFleet: UNLIMITED }).success).toBe(true);
  });
});

describe('isUnlimited', () => {
  it('recognises the literal, with the casing and padding a form field produces', () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(' Unlimited ')).toBe(true);
  });

  it('does not mistake a blank field for an opt-out — the whole point of D-015', () => {
    expect(isUnlimited('')).toBe(false);
    expect(isUnlimited('   ')).toBe(false);
    expect(isUnlimited('12')).toBe(false);
  });
});

describe('ceilingHint — the blank field is the one that needs words', () => {
  it('names the default a blank field resolves to', () => {
    expect(ceilingHint('', 12, 'agents')).toContain('12');
    expect(ceilingHint('', 12, 'agents')).toContain('default');
  });

  it('says unbounded out loud, so it never reads as merely unset', () => {
    expect(ceilingHint(UNLIMITED, 12, 'agents')).toContain('No ceiling');
  });

  it('says nothing when the owner typed a number — the field already speaks', () => {
    expect(ceilingHint('7', 12, 'agents')).toBe('');
  });

  it('says nothing about defaults on a payload that carries none, rather than inventing one', () => {
    expect(ceilingHint('', undefined, 'agents')).toBe('');
  });
});
