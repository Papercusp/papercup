/**
 * The content-detector registry (git-sync-content-guard-2026-06-13 P-003/P-008).
 *
 * Pins the two things the git-sync guard relies on: each detector's SCOPE
 * (`matches`) mirrors the CI lint's exact file set (D-003 — so the guard never
 * quarantines a file the lint wouldn't flag), and its `detect` wrapper normalises
 * the underlying pure detector to a single error string | null. (The MDX detector's
 * no-false-positive corpus behavior is locked separately in check-mdx-guard.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { mdxDetector, smartQuotesDetector, DEFAULT_CONTENT_DETECTORS } from './registry';

describe('mdxDetector', () => {
  it('matches ONLY .mdx under the astro-built docs set (mirrors check-mdx.mjs scope)', () => {
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/x.mdx')).toBe(true);
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/agent-insights/y.mdx')).toBe(true);
    // wrong extension / outside the docs set / excluded tree → not in scope
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/x.md')).toBe(false);
    expect(mdxDetector.matches('docs/elsewhere/x.mdx')).toBe(false);
    expect(mdxDetector.matches('apps/operator-docs/src/content/docs/_retired/old.mdx')).toBe(false);
    expect(mdxDetector.matches('node_modules/pkg/readme.mdx')).toBe(false);
  });

  it('detect returns a positioned error string for a broken doc, null for a valid one', async () => {
    const FM = '---\ntitle: x\n---\n';
    const bad = await mdxDetector.detect('x.mdx', `${FM}\nA "resets <date>" string breaks the build.\n`);
    expect(bad).toMatch(/MDX compile error/i);
    expect(bad).toMatch(/line \d+/);
    expect(await mdxDetector.detect('x.mdx', `${FM}\nA \`<date>\` token in backticks is fine.\n`)).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(mdxDetector.fixerRole).toBe('content-fixer');
  });
});

describe('smartQuotesDetector', () => {
  it('matches tracked .ts/.tsx, excluding retired/vendored/build trees (mirrors check-smart-quotes.mjs)', () => {
    expect(smartQuotesDetector.matches('packages/x/lib/a.ts')).toBe(true);
    expect(smartQuotesDetector.matches('apps/operator/components/B.tsx')).toBe(true);
    expect(smartQuotesDetector.matches('README.md')).toBe(false);
    expect(smartQuotesDetector.matches('node_modules/pkg/index.ts')).toBe(false);
    expect(smartQuotesDetector.matches('_retired/old/a.ts')).toBe(false);
    expect(smartQuotesDetector.matches('packages/x/dist/a.ts')).toBe(false);
  });

  it('detect flags a curly quote used as a code delimiter, leaves a clean file null', () => {
    // a curly quote where a string delimiter belongs → hard parse failure
    const bad = smartQuotesDetector.detect('a.ts', "describe(‘x’, () => {});\n");
    expect(bad).toMatch(/curly\/smart quote used as code/i);
    // straight quotes + a curly apostrophe safely INSIDE a string → clean
    expect(smartQuotesDetector.detect('a.ts', "const s = 'the caller’s value';\n")).toBeNull();
  });

  it('dispatches to the content-fixer role', () => {
    expect(smartQuotesDetector.fixerRole).toBe('content-fixer');
  });
});

describe('DEFAULT_CONTENT_DETECTORS', () => {
  it('ships both seeded detectors, keyed for the guard + escalation', () => {
    expect(DEFAULT_CONTENT_DETECTORS.map((d) => d.key)).toEqual(['mdx', 'smart-quotes']);
  });
});
