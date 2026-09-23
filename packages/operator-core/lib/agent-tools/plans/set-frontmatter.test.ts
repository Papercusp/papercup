import { describe, expect, it } from 'vitest';
import setFrontmatterTool from './set-frontmatter';

describe('plans:set-frontmatter initial lifecycle status', () => {
  const base = { harness: 'papercusp', slug: 'legacy-plan', title: 'Legacy Plan' };

  it('accepts a non-terminal status when converting a legacy plan', () => {
    expect(setFrontmatterTool.args.safeParse({ ...base, status: 'active' }).success).toBe(true);
  });

  it.each(['shipped', 'superseded'])('rejects terminal conversion status %s', (status) => {
    expect(setFrontmatterTool.args.safeParse({ ...base, status }).success).toBe(false);
  });
});
