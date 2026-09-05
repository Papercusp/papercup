import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import createTool from './create';

/**
 * WI-38059 residue: `work_items:create { paths }`.
 *
 * That item's measured rejection burst listed eight correct-intent/wrong-spelling
 * calls. Its two implemented remedies — the nested-path rung (`refs` ->
 * `observation.refs`) and the COMMON_ARG_ALIASES synonym set — resolve the other
 * seven. `paths` is the one neither can reach, because `payload` is declared
 * `z.record(z.string(), z.unknown())`: it renders with no `properties` map, so the
 * nested rung has nothing to walk, and no declared key is within edit distance of
 * `paths`, so the distance rung declines too. The caller gets no pointer at all.
 *
 * The two rungs' behaviour on that shape is pinned in
 * `libs/generic/tooldef/src/strict-args.test.ts` (they live there, and are not
 * re-exported by the package barrel). What THIS file pins is the pair that makes
 * the redirect correct here: the declared shape it is compensating for, and the
 * redirect itself. Asserting only the latter would restate the source and keep
 * passing even if `payload` were later given a typed shape that made the cheaper
 * rung work — at which point the precondition below fails and the redirect gets
 * re-examined instead of quietly becoming dead weight.
 */
describe('work_items:create — `paths` argRedirect (WI-38059 residue)', () => {
  it('declares `payload` as a free-form record, so no cheaper rung can reach payload.paths', () => {
    const declared = z.toJSONSchema(
      z.object({
        title: z.string(),
        kind: z.string(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      { io: 'input' },
    ) as { properties?: Record<string, unknown> };
    const payload = (declared.properties ?? {}).payload as
      | { type?: string; properties?: unknown }
      | undefined;

    expect(payload).toMatchObject({ type: 'object' });
    // The load-bearing half: no `properties` map means nothing for nestedArgPaths
    // to walk. If this ever becomes defined, the redirect below may be redundant.
    expect(payload?.properties).toBeUndefined();
  });

  it('so the authored redirect names payload.paths', () => {
    expect(createTool.guidance?.argRedirects?.paths).toBe('payload.paths');
  });
});
