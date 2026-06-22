/**
 * _slug-requires.test.ts — the shared harness-slug preconditions for artifacts:*
 * tools. SLUG_RE is the one slug grammar enforced everywhere (a too-loose regex
 * would let a path-traversal-ish slug through; too-tight would reject valid
 * harness slugs). slugRequires builds the two declarative specs the dispatcher
 * enforces (slug-present-via-arg-or-ctx, and ctx-slug-must-be-valid), with the
 * tool name in the error + the SLUG_RE source wired into the ctx-validity matcher.
 *
 * Run: cd packages/agent-mcp && npx vitest run src/tools/artifacts/_slug-requires.test.ts
 */
import { describe, expect, it } from 'vitest';
import { SLUG_RE, slugRequires } from './_slug-requires';

describe('SLUG_RE', () => {
  it('accepts lowercase, digits, dot/underscore/hyphen, and (case-insensitive) uppercase', () => {
    for (const ok of ['my-harness', 'a', 'h1', 'a.b_c-1', 'Sheets', 'PaperCup_2']) {
      expect(SLUG_RE.test(ok), ok).toBe(true);
    }
  });
  it('rejects empty, whitespace, slashes, and other path/separator chars', () => {
    for (const bad of ['', 'has space', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b']) {
      expect(SLUG_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('slugRequires', () => {
  it('returns the two preconditions with stable ids', () => {
    const specs = slugRequires('artifacts:save');
    expect(specs.map((s) => s.id)).toEqual(['harness-slug', 'valid-ctx-slug']);
  });

  it('embeds the tool name in each error message', () => {
    const specs = slugRequires('artifacts:load');
    for (const s of specs) expect(s.error).toContain('artifacts:load');
  });

  it('wires the SLUG_RE source into the ctx-slug validity matcher', () => {
    const validCtx = slugRequires('artifacts:save').find((s) => s.id === 'valid-ctx-slug')!;
    const ctxClause = (validCtx.when as { any: Array<Record<string, unknown>> }).any.find(
      (c) => 'ctx.harnessSlug' in c,
    ) as { 'ctx.harnessSlug': { matches: { source: string; flags: string } } };
    expect(ctxClause['ctx.harnessSlug'].matches.source).toBe(SLUG_RE.source);
    expect(ctxClause['ctx.harnessSlug'].matches.flags).toBe('i');
  });

  it('accepts the slug via args.items (bulk), args.slug, OR ctx.harnessSlug (the presence precondition is an any-clause)', () => {
    // The bulk (`items`) path carries per-item slugs the declarative condition
    // can't reach, so `args.items` present short-circuits the precondition and
    // per-item slug validity is re-asserted in the handler.
    const presence = slugRequires('artifacts:save').find((s) => s.id === 'harness-slug')!;
    const keys = (presence.when as { any: Array<Record<string, unknown>> }).any.flatMap((c) => Object.keys(c));
    expect(keys).toEqual(['args.items', 'args.slug', 'ctx.harnessSlug']);
  });

  it('lets the bulk items path short-circuit the ctx-slug validity precondition too', () => {
    const validCtx = slugRequires('artifacts:save').find((s) => s.id === 'valid-ctx-slug')!;
    const keys = (validCtx.when as { any: Array<Record<string, unknown>> }).any.flatMap((c) => Object.keys(c));
    expect(keys).toEqual(['args.items', 'args.slug', 'ctx.harnessSlug']);
  });
});
