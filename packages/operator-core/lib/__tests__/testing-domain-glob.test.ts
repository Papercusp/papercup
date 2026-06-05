/**
 * Tests for testing-domain-glob.ts — the dependency-free walker used
 * by the /api/admin/testing/domains/:id route (P-003).
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitPrefix,
  remainderToRegex,
  expandGlobs,
} from '../testing-domain-glob';

describe('splitPrefix', () => {
  it('keeps a fully-literal path as the prefix', () => {
    expect(splitPrefix('apps/operator/lib/foo.ts')).toEqual([
      'apps/operator/lib/foo.ts',
      '',
    ]);
  });

  it('cuts at the last path boundary before the first metachar', () => {
    expect(splitPrefix('apps/operator/lib/*.test.ts')).toEqual([
      'apps/operator/lib',
      '*.test.ts',
    ]);
  });

  it('handles **/ patterns', () => {
    expect(splitPrefix('apps/operator/lib/voice/**/*.test.ts')).toEqual([
      'apps/operator/lib/voice',
      '**/*.test.ts',
    ]);
  });

  it('handles a meta in the first segment', () => {
    expect(splitPrefix('*.test.ts')).toEqual(['', '*.test.ts']);
  });
});

describe('remainderToRegex', () => {
  it('matches a single-segment * pattern', () => {
    const re = remainderToRegex('*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('foo.test.tsx')).toBe(false);
    expect(re.test('sub/foo.test.ts')).toBe(false); // * does NOT cross /
  });

  it('matches ** across path segments', () => {
    const re = remainderToRegex('**/*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('a/b/c/foo.test.ts')).toBe(true);
    expect(re.test('foo.spec.ts')).toBe(false);
  });

  it('escapes regex metachars in literal segments', () => {
    const re = remainderToRegex('foo.bar.test.ts');
    expect(re.test('foo.bar.test.ts')).toBe(true);
    expect(re.test('fooXbar.test.ts')).toBe(false);
  });

  it('treats literal [brackets] as literals, not a regex char class', () => {
    // Next.js dynamic-route dirs like app/users/github/[id]/... must match
    // the literal `[id]` segment — not the char class [id] (any of i/d).
    const re = remainderToRegex('[id]/x.test.ts');
    expect(re.test('[id]/x.test.ts')).toBe(true);
    expect(re.test('i/x.test.ts')).toBe(false);
    expect(re.test('d/x.test.ts')).toBe(false);
  });

  it('rejects unsupported extglob', () => {
    expect(() => remainderToRegex('!(node_modules)/*.ts')).toThrow(
      /unsupported extglob/,
    );
  });

  it('rejects brace alternation', () => {
    expect(() => remainderToRegex('{a,b}.ts')).toThrow(
      /brace alternation not supported/,
    );
  });
});

describe('expandGlobs against a real tmp dir', () => {
  async function seed(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tdg-'));
    await mkdir(join(dir, 'lib/voice'), { recursive: true });
    await mkdir(join(dir, 'lib/voice/cards'), { recursive: true });
    await mkdir(join(dir, 'lib/harness'), { recursive: true });
    await mkdir(join(dir, 'app/users/[id]/__tests__'), { recursive: true });
    await mkdir(join(dir, 'node_modules/should-skip'), { recursive: true });
    await writeFile(join(dir, 'lib/voice/commands.test.ts'), '');
    await writeFile(join(dir, 'lib/voice/engine-health.test.ts'), '');
    await writeFile(join(dir, 'lib/voice/cards/card.test.ts'), '');
    await writeFile(join(dir, 'lib/voice/notes.md'), '');
    await writeFile(join(dir, 'lib/harness/dock.test.ts'), '');
    await writeFile(join(dir, 'app/users/[id]/__tests__/Profile.test.tsx'), '');
    await writeFile(join(dir, 'node_modules/should-skip/whatever.test.ts'), '');
    return dir;
  }

  it('single-level * pattern only matches one directory deep', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, ['lib/voice/*.test.ts']);
    const paths = hits.map((h) => h.path);
    expect(paths).toEqual([
      'lib/voice/commands.test.ts',
      'lib/voice/engine-health.test.ts',
    ]);
  });

  it('** pattern descends recursively', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, ['lib/voice/**/*.test.ts']);
    const paths = hits.map((h) => h.path);
    expect(paths).toContain('lib/voice/commands.test.ts');
    expect(paths).toContain('lib/voice/cards/card.test.ts');
  });

  it('multiple globs dedupe by path', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, [
      'lib/voice/commands.test.ts',
      'lib/voice/*.test.ts',
    ]);
    const paths = hits.map((h) => h.path);
    expect(paths.filter((p) => p === 'lib/voice/commands.test.ts').length).toBe(1);
  });

  it('skips node_modules directories', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, ['**/*.test.ts']);
    const paths = hits.map((h) => h.path);
    expect(paths.every((p) => !p.startsWith('node_modules'))).toBe(true);
  });

  it('matches globs through literal [param] (Next.js dynamic-route) dirs', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, ['app/users/[id]/__tests__/**/*.test.tsx']);
    expect(hits.map((h) => h.path)).toEqual(['app/users/[id]/__tests__/Profile.test.tsx']);
  });

  it('returns size + mtime for each hit', async () => {
    const root = await seed();
    const hits = await expandGlobs(root, ['lib/voice/commands.test.ts']);
    expect(hits).toHaveLength(1);
    expect(hits[0].sizeBytes).toBeGreaterThanOrEqual(0);
    expect(hits[0].mtimeMs).toBeGreaterThan(0);
  });
});
