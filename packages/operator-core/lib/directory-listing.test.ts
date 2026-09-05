/**
 * Tests for listDirectory (plan bash-substitution-reachable-ceiling-2026-08-01, P-012 / D-068).
 *
 * The properties under test are the ones that JUSTIFY the tool existing at all —
 * D-058 measured bash->tool as token-inflating, so the case is correctness. Each
 * block below pins one of the four header claims, and the UTC block carries an
 * inline CALIBRATION control: a locally-rendered timestamp the assertion must still
 * reject, so the test cannot pass by being vacuous if toISOString() is ever swapped
 * for a locale/local-offset formatter.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listDirectory,
  DirectoryListingError,
  DIRECTORY_LISTING_DEFAULT_LIMIT,
} from './directory-listing';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dirlist-'));
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'alpha.txt'), 'a'.repeat(11));
  writeFileSync(join(root, 'beta.txt'), 'bb');
  writeFileSync(join(root, '.hidden'), 'h');
  // A symlink pointing at a directory — the `find` blind spot CLAUDE.md documents.
  symlinkSync(join(root, 'sub'), join(root, 'link-to-dir'));
  symlinkSync(join(root, 'nope-does-not-exist'), join(root, 'broken-link'));

  // Deterministic mtimes for the sort assertion.
  utimesSync(join(root, 'alpha.txt'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  utimesSync(join(root, 'beta.txt'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listDirectory', () => {
  it('lists visible entries and excludes dot-entries by default, counting what it hid', () => {
    const r = listDirectory({ path: root });
    const names = r.entries.map((e) => e.name);
    expect(names).toContain('alpha.txt');
    expect(names).toContain('sub');
    expect(names).not.toContain('.hidden');
    expect(r.hiddenExcluded).toBe(1);
  });

  it('includes dot-entries under all:true', () => {
    const r = listDirectory({ path: root, all: true });
    expect(r.entries.map((e) => e.name)).toContain('.hidden');
    expect(r.hiddenExcluded).toBe(0);
  });

  describe('mtimeUtc is UTC by construction (the phantom-4h-gap trap)', () => {
    it('renders an ISO-8601 Z timestamp that round-trips to the real instant', () => {
      const r = listDirectory({ path: root });
      const alpha = r.entries.find((e) => e.name === 'alpha.txt');
      expect(alpha?.mtimeUtc).toBe('2026-01-01T00:00:00.000Z');
      expect(new Date(alpha!.mtimeUtc!).getTime()).toBe(Date.parse('2026-01-01T00:00:00Z'));
    });

    it('every entry ends in Z and carries no numeric UTC offset', () => {
      const r = listDirectory({ path: root, all: true });
      for (const e of r.entries) {
        if (e.mtimeUtc === null) continue;
        expect(e.mtimeUtc).toMatch(/Z$/);
        expect(e.mtimeUtc).not.toMatch(/[+-]\d{2}:\d{2}$/);
      }
    });

    it('CALIBRATION: the same assertions REJECT a locally-rendered stamp', () => {
      // If toISOString() were swapped for a local/locale formatter, rows would look
      // like this. The control proves the two assertions above can actually fail —
      // without it they would also pass on a listing that returned no timestamps.
      const localStyle = '2026-01-01 00:00:00.000 -0400';
      const offsetStyle = '2026-01-01T00:00:00.000-04:00';
      expect(localStyle).not.toMatch(/Z$/);
      expect(offsetStyle).toMatch(/[+-]\d{2}:\d{2}$/);
    });
  });

  describe('symlinks are disclosed, never silently followed or skipped', () => {
    it('reports a symlink as a symlink, with its target and what the target is', () => {
      const r = listDirectory({ path: root });
      const link = r.entries.find((e) => e.name === 'link-to-dir');
      expect(link?.type).toBe('symlink');
      expect(link?.symlinkResolvesTo).toBe('dir');
      expect(link?.symlinkTarget).toContain('sub');
      expect(r.symlinkedDirs).toBe(1);
    });

    it('reports a broken symlink as broken rather than omitting it', () => {
      const r = listDirectory({ path: root });
      const broken = r.entries.find((e) => e.name === 'broken-link');
      expect(broken?.type).toBe('symlink');
      expect(broken?.symlinkResolvesTo).toBe('broken');
    });

    it('does not classify a symlinked directory as a plain dir', () => {
      const r = listDirectory({ path: root });
      expect(r.entries.find((e) => e.name === 'link-to-dir')?.type).not.toBe('dir');
      expect(r.entries.find((e) => e.name === 'sub')?.type).toBe('dir');
    });
  });

  describe('a bounded listing cannot be read as a complete one', () => {
    it('marks truncation and still reports the true total', () => {
      const r = listDirectory({ path: root, limit: 2 });
      expect(r.matched).toBe(2);
      expect(r.truncated).toBe(true);
      expect(r.total).toBeGreaterThan(2);
    });

    it('is not truncated when everything fits', () => {
      const r = listDirectory({ path: root });
      expect(r.truncated).toBe(false);
      expect(r.matched).toBe(r.total);
    });

    it('has a bounded default so an unbounded directory cannot flood a result', () => {
      expect(DIRECTORY_LISTING_DEFAULT_LIMIT).toBeGreaterThan(0);
      expect(DIRECTORY_LISTING_DEFAULT_LIMIT).toBeLessThanOrEqual(1000);
    });
  });

  describe('an empty listing means empty — failures throw instead', () => {
    it('throws not_found for a missing path', () => {
      try {
        listDirectory({ path: join(root, 'no-such-dir') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DirectoryListingError);
        expect((e as DirectoryListingError).code).toBe('not_found');
      }
    });

    it('throws not_a_directory for a file, rather than returning []', () => {
      try {
        listDirectory({ path: join(root, 'alpha.txt') });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DirectoryListingError);
        expect((e as DirectoryListingError).code).toBe('not_a_directory');
      }
    });

    it('returns a genuinely empty listing for a genuinely empty directory', () => {
      const empty = join(root, 'empty-dir');
      mkdirSync(empty, { recursive: true });
      const r = listDirectory({ path: empty });
      expect(r.entries).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.truncated).toBe(false);
    });
  });

  describe('sorting and filtering', () => {
    it('sorts by name by default', () => {
      const r = listDirectory({ path: root });
      const names = r.entries.map((e) => e.name);
      expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    });

    it('sorts newest-first under sort:"mtime" (the ls -t shape)', () => {
      const r = listDirectory({ path: root, sort: 'mtime', contains: '.txt' });
      expect(r.entries.map((e) => e.name)).toEqual(['beta.txt', 'alpha.txt']);
    });

    it('filters by substring, case-insensitively', () => {
      const r = listDirectory({ path: root, contains: 'ALPHA' });
      expect(r.entries.map((e) => e.name)).toEqual(['alpha.txt']);
      expect(r.total).toBe(1);
    });

    it('reports byte sizes for files', () => {
      const r = listDirectory({ path: root, contains: 'alpha' });
      expect(r.entries[0]?.bytes).toBe(11);
    });
  });
});
