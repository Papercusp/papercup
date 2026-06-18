import { describe, it, expect } from 'vitest';
import { blankFrontmatter, findMdxCompileError } from './mdx';

describe('blankFrontmatter', () => {
  it('returns the text unchanged when there is no leading frontmatter fence', () => {
    const text = '# Title\n\nsome prose\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('does not treat a `---` that is not on the first line as frontmatter', () => {
    // A horizontal rule mid-document must NOT be blanked.
    const text = 'intro line\n---\nafter the rule\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('blanks a valid frontmatter block to empty lines and preserves the body + line count', () => {
    const text = '---\ntitle: Hi\nslug: hi\n---\n# Body\n\ntext\n';
    const out = blankFrontmatter(text);
    // Same number of lines (blanked, not removed) — so compile errors still
    // point at the right source line.
    expect(out.split('\n').length).toBe(text.split('\n').length);
    // The four frontmatter lines (--- title slug ---) are now empty.
    const outLines = out.split('\n');
    expect(outLines.slice(0, 4)).toEqual(['', '', '', '']);
    // The body is untouched.
    expect(out).toContain('# Body');
    expect(out).toContain('text');
    expect(out).not.toContain('title: Hi');
  });

  it('leaves an unterminated frontmatter fence intact (lets the compiler report it)', () => {
    const text = '---\ntitle: Hi\nno closing fence\nstill going\n';
    expect(blankFrontmatter(text)).toBe(text);
  });

  it('blanks a minimal empty frontmatter block (--- immediately followed by ---)', () => {
    const text = '---\n---\nbody\n';
    const out = blankFrontmatter(text);
    expect(out.split('\n')).toEqual(['', '', 'body', '']);
  });
});

describe('findMdxCompileError', () => {
  it('returns null for plain valid markdown/MDX', async () => {
    const err = await findMdxCompileError('ok.mdx', '# Hello\n\nSome **bold** and a [link](https://x).\n');
    expect(err).toBeNull();
  });

  it('returns null when valid content carries YAML frontmatter (frontmatter is blanked first)', async () => {
    const text = '---\ntitle: Doc\n---\n# Heading\n\nclean prose\n';
    const err = await findMdxCompileError('fm.mdx', text);
    expect(err).toBeNull();
  });

  it('returns null for GFM syntax (remark-gfm is wired into the pipeline)', async () => {
    const table = '# T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~struck~~\n';
    const err = await findMdxCompileError('gfm.mdx', table);
    expect(err).toBeNull();
  });

  it('reports a syntax error for a bare angle-bracket token written in prose', async () => {
    // `<date>` outside a code span is parsed as a JSX open tag with no close —
    // a hard MDX/astro build failure. This is the exact EI-438 case.
    const text = '# Heading\n\nUse the <date> placeholder here.\n';
    const err = await findMdxCompileError('bad.mdx', text);
    expect(err).not.toBeNull();
    expect(typeof err!.reason).toBe('string');
    expect(err!.reason.length).toBeGreaterThan(0);
    // reason is a single line (the detector splits on the first newline).
    expect(err!.reason).not.toContain('\n');
    // line/col are either a positive number or null — never NaN/undefined.
    expect(err!.line === null || (typeof err!.line === 'number' && err!.line >= 1)).toBe(true);
    expect(err!.col === null || (typeof err!.col === 'number' && err!.col >= 1)).toBe(true);
  });

  it('does NOT flag a bare angle-bracket token when it is inside a code span', async () => {
    // The same `<date>` token, but in an inline code span, compiles cleanly —
    // proving detection is the real compiler, not a regex (zero false positive).
    const err = await findMdxCompileError('codespan.mdx', 'Use the `<date>` placeholder.\n');
    expect(err).toBeNull();
  });
});
