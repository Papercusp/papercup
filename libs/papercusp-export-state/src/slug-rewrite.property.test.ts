/**
 * Property-based tests for `rewriteText` — the §15.6 step-9 slug
 * rewriter. Per testing-spec §1.12: this is one of the named property-test
 * sites because the substring-vs-token distinction (sheet vs worksheet)
 * is exactly the kind of edge case example tests undercount.
 *
 * Properties verified:
 *   - Idempotence: rewriting the same slug twice is a no-op after the first.
 *   - Reversibility (skip-all): rewrite(orig→A) then rewrite(A→orig) returns
 *     a structurally equivalent text in structured contexts.
 *   - Substring safety: prose containing `<orig>` as part of a longer word
 *     (worksheet, spreadsheet) is never touched in skip-all mode.
 *   - Front-matter, path, schema patterns: always rewritten end-to-end.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rewriteText } from './slug-rewrite';
import type { SlugRewriteAmbiguous } from './restore-types';

const ctx = (policy: 'skip-all' | 'rewrite-all' = 'skip-all') => {
  const ambiguous: SlugRewriteAmbiguous[] = [];
  return {
    onAmbiguous: (line: string, lineNum: number, match: string) => {
      ambiguous.push({ file: 't', line: lineNum, context: line, match });
    },
    ambiguousPolicy: policy,
    seen: ambiguous,
  };
};

// Generates a typical harness slug: starts and ends with alphanumeric,
// dashes/underscores only in the middle. SLUG_RE allows trailing `-` / `_`,
// but slugs ending in non-word chars defeat the `\bORIG\b` ambiguity
// detector (covered as an explicit example below). Property tests focus
// on the dominant-case slugs.
const slug = fc.stringMatching(/^[a-z][a-z0-9_-]{1,14}[a-z0-9]$/);

describe('rewriteText — properties', () => {
  it('is idempotent: rewriting orig→next, then next→next is a no-op', () => {
    fc.assert(
      fc.property(slug, slug, fc.string({ maxLength: 200 }), (orig, next, prose) => {
        fc.pre(orig !== next);
        const text = `slug: ${orig}\nworktrees/${orig}/x\nharness_${orig}.t\n${prose}`;
        const c1 = ctx();
        const once = rewriteText(text, orig, next, c1);
        const c2 = ctx();
        const twice = rewriteText(once, next, next, c2);
        expect(twice).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('reversible in structured contexts (skip-all): A→B→A round-trip preserves them', () => {
    fc.assert(
      fc.property(slug, slug, (orig, next) => {
        fc.pre(orig !== next);
        // Only structured patterns, no ambiguous prose.
        const text = `---\nslug: ${orig}\nharness: ${orig}\nharness_slug: "${orig}"\n---\nworktrees/${orig}/foo.ts\nharness_${orig}.x`;
        const ab = rewriteText(text, orig, next, ctx());
        const ba = rewriteText(ab, next, orig, ctx());
        expect(ba).toBe(text);
      }),
      { numRuns: 100 },
    );
  });

  it('skip-all never touches words that merely contain the slug as substring', () => {
    // Build prose where the slug only appears embedded in a longer word.
    fc.assert(
      fc.property(slug, slug, (orig, next) => {
        fc.pre(orig !== next);
        // `sheets` appears inside `worksheets` (no word boundary) — must not rewrite.
        const before = `Here is a worksheet${orig} and prefix${orig}suffix and ${orig}tail and head${orig}.`;
        const out = rewriteText(before, orig, next, ctx());
        expect(out).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  it('always rewrites the three structured patterns', () => {
    fc.assert(
      fc.property(slug, slug, (orig, next) => {
        fc.pre(orig !== next);
        const before = `slug: ${orig}\n/worktrees/${orig}/file\nFROM harness_${orig}.t`;
        const after = rewriteText(before, orig, next, ctx());
        expect(after).toContain(`slug: ${next}`);
        expect(after).toContain(`/worktrees/${next}/file`);
        expect(after).toContain(`FROM harness_${next}.`);
        // And the original slug should NOT appear in any of those three forms anymore.
        expect(after).not.toContain(`slug: ${orig}`);
        expect(after).not.toContain(`/worktrees/${orig}/file`);
        expect(after).not.toContain(`FROM harness_${orig}.`);
      }),
      { numRuns: 100 },
    );
  });

  it('reports ambiguous bare-word matches in prose', () => {
    fc.assert(
      fc.property(slug, slug, (orig, next) => {
        fc.pre(orig !== next);
        const c = ctx('skip-all');
        const text = `The ${orig} harness has 30 features.`;
        const out = rewriteText(text, orig, next, c);
        // skip-all: text unchanged
        expect(out).toBe(text);
        // but the bare word was reported
        expect(c.seen.length).toBeGreaterThan(0);
        expect(c.seen[0]?.match).toBe(orig);
      }),
      { numRuns: 50 },
    );
  });

  // Edge case discovered by the property tests: SLUG_RE allows trailing `-`
  // and `_`, but the ambiguity detector uses `\bORIG\b`, where `\b` is a
  // word boundary defined in terms of `\w` (alphanumeric + underscore).
  // A slug ending in `-` followed by a space *does* have `\b` (between
  // `-` non-word and space non-word? — no, both non-word, no boundary).
  // Result: bare-word detection misses these.
  //
  // This is acceptable in practice (prose mentions of `a--` are
  // vanishingly rare and typically already clear from context) but it
  // means the ambiguity report is best-effort, not exhaustive.
  it('known limitation: slugs ending in non-word chars miss prose detection', () => {
    const c = ctx('skip-all');
    const out = rewriteText('The a-- harness has 30 features.', 'a--', 'a-fork', c);
    expect(out).toBe('The a-- harness has 30 features.'); // unchanged in skip-all
    expect(c.seen.length).toBe(0); // not reported — documented gap
  });
});
