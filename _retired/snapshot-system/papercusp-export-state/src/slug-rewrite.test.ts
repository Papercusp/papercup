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

describe('rewriteText', () => {
  it('rewrites front-matter slug:/harness:/harness_slug: keys', () => {
    const c = ctx();
    const out = rewriteText(
      `---\nslug: sheets\nharness: sheets\nharness_slug: "sheets"\n---\n`,
      'sheets',
      'sheets-fork-a3k9q2',
      c,
    );
    expect(out).toContain('slug: sheets-fork-a3k9q2');
    expect(out).toContain('harness: sheets-fork-a3k9q2');
    expect(out).toContain('harness_slug: "sheets-fork-a3k9q2"');
  });

  it('rewrites path components with surrounding slashes', () => {
    const c = ctx();
    const out = rewriteText(
      `worktrees/sheets/foo.ts\nworktrees/sheets`,
      'sheets',
      'sheets-fork-a3k9q2',
      c,
    );
    expect(out).toContain('worktrees/sheets-fork-a3k9q2/foo.ts');
    expect(out).toContain('worktrees/sheets-fork-a3k9q2');
  });

  it('rewrites DB schema references harness_<slug>.<x>', () => {
    const c = ctx();
    const out = rewriteText(
      `SELECT * FROM harness_sheets.harness_features WHERE x;`,
      'sheets',
      'sheets-fork-a3k9q2',
      c,
    );
    expect(out).toBe(
      `SELECT * FROM harness_sheets-fork-a3k9q2.harness_features WHERE x;`,
    );
  });

  it('does NOT rewrite unrelated tokens that contain slug as substring', () => {
    const c = ctx();
    const before =
      `// This worksheet uses spreadsheet-style cells. cheatsheet inside.\nThe sheets harness has 30 features.`;
    const out = rewriteText(before, 'sheets', 'sheets-fork-a3k9q2', c);
    // worksheet / spreadsheet / cheatsheet untouched
    expect(out).toContain('worksheet');
    expect(out).toContain('spreadsheet-style');
    expect(out).toContain('cheatsheet');
    // The bare-word `sheets` in prose surfaces as ambiguous (skipped by default)
    expect(c.seen.some((a) => a.match === 'sheets')).toBe(true);
    expect(out).toContain('The sheets harness has');
  });

  it('rewrite-all policy does change ambiguous matches', () => {
    const c = ctx('rewrite-all');
    const out = rewriteText(
      `The sheets harness has 30 features.`,
      'sheets',
      'sheets-fork-a3k9q2',
      c,
    );
    expect(out).toBe(`The sheets-fork-a3k9q2 harness has 30 features.`);
  });

  it('handles regex-meta characters in original slug safely', () => {
    const c = ctx();
    expect(() =>
      rewriteText(`x slug: foo.bar\n`, 'foo.bar', 'foo.bar-fork-x', c),
    ).not.toThrow();
  });
});
