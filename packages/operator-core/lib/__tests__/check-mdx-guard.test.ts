/**
 * check-mdx-guard.test.ts — the MDX compile guard's detector (EI-438).
 *
 * The guard (`scripts/check-mdx.mjs`) runs green over the real docs tree in CI,
 * which proves the no-FALSE-POSITIVE direction on the live corpus. This locks
 * the two things that matter and that a clean-tree run can't prove:
 *   1. it FAILS on the actual break — a bare `<word>` placeholder in prose
 *      parsed as an unclosed JSX tag (the 2026-06-13 `<date>` break);
 *   2. it does NOT false-positive on the legitimate shapes that motivated the
 *      remark-gfm + code-span handling (a table cell with a backticked tag, an
 *      undefined Starlight component) — a detector that went lenient OR
 *      over-eager would slip past the clean-tree run but is caught here.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { findMdxCompileError, blankFrontmatter } from '../../../../scripts/check-mdx.mjs';

const FM = '---\ntitle: x\n---\n';

describe('check-mdx guard detector (EI-438)', () => {
  it('FLAGS a bare <word> placeholder in prose (the unclosed-JSX-tag break)', async () => {
    const bad = `${FM}\n# Hi\n\nA "resets <date>" string in prose breaks the build.\n`;
    const hit = await findMdxCompileError('bad.mdx', bad);
    expect(hit).not.toBeNull();
    expect(hit.reason).toMatch(/closing tag for `<date>`/i);
    // Frontmatter is blanked with line count preserved, so the line still
    // points at source (the `<date>` is on the 7th line of `bad`).
    expect(hit.line).toBe(7);
  });

  it('does NOT flag the same placeholder inside an inline code span', async () => {
    const good = `${FM}\n# Hi\n\nA \`<date>\` token in backticks is fine.\n`;
    expect(await findMdxCompileError('good.mdx', good)).toBeNull();
  });

  it('does NOT flag an undefined Starlight component used + closed', async () => {
    const good = `${FM}\n<Aside type="note" title="x">body</Aside>\n`;
    expect(await findMdxCompileError('aside.mdx', good)).toBeNull();
  });

  it('does NOT flag a GFM table cell with a backticked tag (remark-gfm parity — the lifecycle.mdx case)', async () => {
    const good =
      `${FM}\n| Surface | Via |\n|---|---|\n` +
      '| Architect | embedded via `<ArchitectInbox><ArchitectChat>` |\n';
    expect(await findMdxCompileError('table.mdx', good)).toBeNull();
  });

  it('blankFrontmatter strips the --- … --- block but preserves line count', () => {
    const out = blankFrontmatter('---\ntitle: x\nslug: y\n---\n# Body\n');
    const lines = out.split('\n');
    expect(lines.slice(0, 4)).toEqual(['', '', '', '']); // 4 frontmatter lines blanked
    expect(lines[4]).toBe('# Body'); // body line index unchanged
  });

  it('leaves a doc with no frontmatter untouched', () => {
    const src = '# No frontmatter\n\ntext\n';
    expect(blankFrontmatter(src)).toBe(src);
  });
});
