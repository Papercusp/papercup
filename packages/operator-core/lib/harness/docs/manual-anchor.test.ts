import { describe, it, expect } from 'vitest';
import { frontmatterDocuments, inferSubjectFromBody } from './manual-anchor';

describe('frontmatterDocuments', () => {
  it('reads a scalar documents: value', () => {
    const body = '---\ntitle: X\ndocuments: F-3\n---\n# hi';
    expect(frontmatterDocuments(body)).toBe('F-3');
  });

  it('reads an inline flow array', () => {
    const body = "---\ndocuments: [src/a.ts, 'src/b.ts', F-1]\n---\nbody";
    expect(frontmatterDocuments(body)).toEqual(['src/a.ts', 'src/b.ts', 'F-1']);
  });

  it('reads a block list', () => {
    const body = '---\ntitle: T\ndocuments:\n  - src/a.ts\n  - src/b.ts :: fn\ntags: x\n---\nbody';
    expect(frontmatterDocuments(body)).toEqual(['src/a.ts', 'src/b.ts :: fn']);
  });

  it('returns undefined when no frontmatter / no documents key', () => {
    expect(frontmatterDocuments('# no frontmatter')).toBeUndefined();
    expect(frontmatterDocuments('---\ntitle: X\n---\nbody')).toBeUndefined();
  });
});

describe('inferSubjectFromBody', () => {
  it('infers repo-path tokens from inline code', () => {
    const body = 'See `src/auth/login.ts` and `packages/x/util.rs` for details. Also `notAPath`.';
    const refs = inferSubjectFromBody(body);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'path' });
    const globs = refs[0].kind === 'path' ? refs[0].globs : [];
    expect(globs).toContain('src/auth/login.ts');
    expect(globs).toContain('packages/x/util.rs');
    expect(globs).not.toContain('notAPath');
  });

  it('returns [] when nothing path-like is present', () => {
    expect(inferSubjectFromBody('just prose with `code` and `words`')).toEqual([]);
  });
});
