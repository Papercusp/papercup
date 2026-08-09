/**
 * WI-3646 CLASS guard — `harness:create`'s args schema must be `.strict()`.
 *
 * THE CLASS: a caller sending a field name the schema does not declare (`hive`
 * instead of the real `pot`) had the extra key SILENTLY DROPPED by zod's default
 * non-strict object. `args.pot` stayed `undefined`, the new harness never got
 * `hive_slug` stamped, and NOTHING errored anywhere — producing silent zero
 * federation of the owner's content. It shipped broken and survived three
 * separate mis-triages because the failure mode is an absence, not an error.
 *
 * `.strict()` (create.ts, applied between the `.object({...})` and the two
 * `.refine()`s) is what closes the class: any future field-name typo or drift on
 * this schema becomes a loud validation error instead of an undetectable no-op.
 *
 * WHY THIS FILE EXISTS: that class fix had NO direct guard. It was validated by
 * hand — reverting `.strict()` and re-running (see the comment in
 * `create-git-sync-seed.integration.test.ts`) — which leaves no durable
 * artifact, so any refactor dropping `.strict()` would silently re-arm the whole
 * class. The only adjacent coverage lives in an *.integration.test.ts, which is
 * NOT in the default unit-only `test:affected` sweep; this file is a unit test
 * so it runs routinely.
 *
 * FALSIFIABILITY: proving a guard can fail must never mutate the shared tree
 * (a git-sync tick would commit the mutant). Instead this file carries a
 * permanent NON-STRICT control built from the same shape — it accepts the stray
 * key, demonstrating that the assertions below genuinely discriminate strict
 * from non-strict rather than passing vacuously. The calibration case guards the
 * other direction: it proves the fixture is otherwise VALID, so a rejection can
 * only be attributable to the stray key.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import createTool from '../create';

/** Minimal fixture that satisfies BOTH of the schema's `.refine()`s. */
const VALID_ARGS = {
  slug: 'member-x',
  path: '/tmp/member-x',
  blueprintId: 'coding',
} as const;

const argsSchema = createTool.args as unknown as z.ZodType<unknown>;

describe('harness:create args schema is strict (WI-3646 class guard)', () => {
  it('CALIBRATION: the fixture parses cleanly on its own', () => {
    // Without this, every rejection below could be caused by an invalid fixture
    // rather than by the stray key — i.e. the guard would pass while measuring
    // nothing at all.
    const ok = argsSchema.safeParse({ ...VALID_ARGS });
    expect(ok.success).toBe(true);
  });

  it('CALIBRATION: the REAL create-time membership field `pot` is accepted', () => {
    // A schema that rejected everything would satisfy the rejection assertions
    // below for entirely the wrong reason. `pot` is the field the whole bug was
    // about, so it must still parse.
    const ok = argsSchema.safeParse({ ...VALID_ARGS, pot: 'my-pot' });
    expect(ok.success).toBe(true);
  });

  it('rejects the historical `hive` key instead of silently dropping it', () => {
    const res = argsSchema.safeParse({ ...VALID_ARGS, hive: 'my-pot' });
    expect(res.success).toBe(false);
    if (res.success) return;
    // The rejection must NAME the offending key — "loud" is the point of the
    // fix; an anonymous validation error is barely better than a silent drop.
    expect(JSON.stringify(res.error.issues)).toContain('hive');
  });

  it('rejects ANY undeclared key — the class, not just the one instance', () => {
    // `potts` is a plausible typo of the real field. If the guard only caught
    // the literal string `hive` it would be pinning an instance, not the class.
    const res = argsSchema.safeParse({ ...VALID_ARGS, potts: 'my-pot' });
    expect(res.success).toBe(false);
  });

  it('CONTROL: the same shape WITHOUT .strict() accepts the stray key', () => {
    // The deliberately-wrong implementation, kept permanently in the test file
    // so falsifiability is demonstrated without ever mutating production code.
    // If this control ever starts REJECTING, the assertions above have stopped
    // discriminating and this whole file has gone vacuous.
    const nonStrict = z.object({
      slug: z.string().min(1),
      path: z.string().min(1).optional(),
      blueprintId: z.string().min(1).optional(),
      pot: z.string().min(1).optional(),
    });
    const res = nonStrict.safeParse({ ...VALID_ARGS, hive: 'my-pot' });
    expect(res.success).toBe(true);
    // ...and the dropped key is exactly the silent data loss the class fix ends.
    expect(res.success && 'hive' in (res.data as Record<string, unknown>)).toBe(false);
  });
});
