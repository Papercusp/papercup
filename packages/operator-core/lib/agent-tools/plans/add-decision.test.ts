/**
 * plans:add-decision — `itemRefs` alias for `refs` (EI-18735663944089262).
 *
 * plans:get echoes a decision's item refs back under the field name
 * `itemRefs`, but plans:add-decision only ever declared `refs` — so writing
 * back exactly what you just read was rejected with `Unrecognized key:
 * "itemRefs"`. This declares `itemRefs` as an accepted alias (schema-level,
 * so the EI-10883 closed-shape guard still rejects genuinely unknown keys)
 * and has the handler prefer `refs` when both are supplied.
 *
 * Schema-only (no DB): `tool.args` is the same `strictArgs(...)`-wrapped
 * zod schema the dispatcher validates every call against, so a
 * `safeParse` here exercises exactly what a live call would hit.
 */
import { describe, it, expect } from 'vitest';
import tool from './add-decision';

describe('plans:add-decision — itemRefs alias for refs', () => {
  it('accepts `itemRefs` on a single-decision call (the exact read-then-write repro)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['P-008', 'P-012'],
    });
    expect(parsed.success).toBe(true);
  });

  it('still accepts the canonical `refs` field', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      refs: ['P-008'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts `itemRefs` on a per-item entry of a bulk `items` call', () => {
    const parsed = tool.args.safeParse({
      items: [
        { slug: 'some-plan', title: 'A decision', body: 'Body text.', itemRefs: ['P-008'] },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a genuinely unknown key (EI-10883 closed shape intact)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      notAField: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed itemRefs entry the same way refs is validated (P-NNN shape)', () => {
    const parsed = tool.args.safeParse({
      slug: 'some-plan',
      title: 'A decision',
      body: 'Body text.',
      itemRefs: ['not-a-p-id'],
    });
    expect(parsed.success).toBe(false);
  });
});
