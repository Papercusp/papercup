/**
 * _tool-context.ts — compile-time guard for the EI-10968 fix.
 *
 * These are TYPE assertions, not runtime behavior: the whole point of
 * `PapercuspToolContext` / `PapercuspUnifiedToolContext` is that `ctx.tx<T>`
 * actually binds `T` instead of silently discarding it (see the file doc). A
 * runtime test can't observe that — a future edit that widens `tx` back to
 * `any` would still pass every runtime assertion while quietly re-opening the
 * bug. So this file is deliberately `// @ts-expect-error`-driven: it fails
 * `npm run typecheck` (not `npm test`) if the binding regresses.
 */
import { describe, it, expect } from 'vitest';
import type { PapercuspToolContext, PapercuspUnifiedToolContext } from './_tool-context';

interface Row {
  id: string;
  count: number;
}

describe('_tool-context — ctx.tx<T> actually binds T (EI-10968)', () => {
  it('PapercuspUnifiedToolContext: ctx.tx<Row[]> types the awaited result as Row[], not any', () => {
    async function _typeOnly(ctx: PapercuspUnifiedToolContext) {
      const rows = await ctx.tx!<Row[]>`SELECT 1`;
      // If `tx`'s type argument were decorative (the EI-10968 bug), `rows` would be
      // `any` and this `.map` callback param `r` would ALSO be `any` — no error. With
      // the fix, `r` is `Row`, so a bad property access is a compile error.
      const ids = rows.map((r) => r.id);
      // @ts-expect-error — `nope` is not a field of Row; this must still error under the fix.
      const _bad = rows.map((r) => r.nope);
      return { ids, _bad };
    }
    void _typeOnly;
    expect(true).toBe(true);
  });

  it('PapercuspToolContext: ctx.tx<Row[]> types the awaited result as Row[], not any', () => {
    async function _typeOnly(ctx: PapercuspToolContext) {
      const rows = await ctx.tx!<Row[]>`SELECT 1`;
      const ids = rows.map((r) => r.id);
      // @ts-expect-error — same guard as above, for the principal-gated alias.
      const _bad = rows.map((r) => r.nope);
      return { ids, _bad };
    }
    void _typeOnly;
    expect(true).toBe(true);
  });
});
