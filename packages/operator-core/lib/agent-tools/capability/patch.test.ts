/**
 * Hermetic tests for capability:patch — the managed multi-file patch adapter
 * (P-006, gap `patch-notebook-adapters`).
 *
 * The gap's falsifier is "Hermetic and real-client tests prove atomic multi-file
 * patch and notebook semantics through managed authority and locks", so these
 * assert BOTH halves explicitly:
 *   - atomic: a rejected hunk in ANY file leaves EVERY file byte-unchanged;
 *   - through locks: guardFileLock receives every distinct resolved target path,
 *     once, for the whole operation — not one lock per hunk.
 *
 * Temp paths live OUTSIDE any git repo (`mkNonRepoTmpDir`), so the lock is
 * uncoordinated and guardFileLock runs the body directly with no PG — the same
 * arrangement file-tools.test.ts uses, and the reason EI-5826 requires that
 * helper rather than a bare os.tmpdir().
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';
import { occurrences, spliceLiteral, squashWhitespace } from './text-splice';

/** Records the paths every guardFileLock call was asked to hold, then delegates to the real guard. */
const lockedPathSets: string[][] = [];
vi.mock('../locks/file-lock-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../locks/file-lock-guard')>();
  return {
    ...actual,
    guardFileLock: (ctx: unknown, paths: string[], spec: unknown, run: () => unknown) => {
      lockedPathSets.push([...paths]);
      return (actual.guardFileLock as unknown as (...a: unknown[]) => unknown)(ctx, paths, spec, run);
    },
  };
});

const patchTool = (await import('./patch')).default;

const DIR = mkNonRepoTmpDir('cap-patch-');
const ctx = {
  projectDir: DIR,
  stateDir: DIR,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
} as never;

function parse(r: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

let seq = 0;
/** Create a uniquely-named file in the non-repo temp dir and return its absolute path. */
function fixture(name: string, body: string): string {
  const p = join(DIR, `${seq++}-${name}`);
  writeFileSync(p, body, 'utf8');
  return p;
}

async function patch(edits: unknown[]) {
  return (await patchTool.handler!({ edits } as never, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
}

beforeEach(() => {
  lockedPathSets.length = 0;
});

describe('capability:patch — atomicity across files', () => {
  it('applies hunks in several files as one unit', async () => {
    const a = fixture('a.ts', 'export const NAME = "old";\n');
    const b = fixture('b.ts', 'import { NAME } from "./a";\nconsole.log(NAME);\n');

    const r = await patch([
      { file_path: a, old_string: '"old"', new_string: '"new"' },
      { file_path: b, old_string: 'console.log(NAME)', new_string: 'console.info(NAME)' },
    ]);

    expect(r.isError).not.toBe(true);
    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.filesWritten).toBe(2);
    expect(out.hunks).toBe(2);
    expect(readFileSync(a, 'utf8')).toBe('export const NAME = "new";\n');
    expect(readFileSync(b, 'utf8')).toContain('console.info(NAME)');
  });

  it('writes NOTHING when a later hunk does not match — the first file is left byte-identical', async () => {
    const before = 'export const NAME = "old";\n';
    const a = fixture('a.ts', before);
    const b = fixture('b.ts', 'unrelated contents\n');

    const r = await patch([
      { file_path: a, old_string: '"old"', new_string: '"new"' },
      { file_path: b, old_string: 'NOT PRESENT ANYWHERE', new_string: 'x' },
    ]);

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('hunk_not_found');
    // The whole point of the adapter: hunk 0 was perfectly valid and is still not applied.
    expect(readFileSync(a, 'utf8')).toBe(before);
    expect(readFileSync(b, 'utf8')).toBe('unrelated contents\n');
  });

  it('writes NOTHING when a hunk is ambiguous and replace_all was not set', async () => {
    const before = 'x\n';
    const a = fixture('a.ts', before);
    const b = fixture('b.ts', 'dup\ndup\n');

    const r = await patch([
      { file_path: a, old_string: 'x', new_string: 'y' },
      { file_path: b, old_string: 'dup', new_string: 'z' },
    ]);

    expect(r.isError).toBe(true);
    const out = parse(r);
    expect(out.reason).toBe('hunk_not_unique');
    expect(String(out.message)).toContain('matches 2 times');
    expect(readFileSync(a, 'utf8')).toBe(before);
    expect(readFileSync(b, 'utf8')).toBe('dup\ndup\n');
  });

  it('rejects an identical old/new hunk before touching the filesystem', async () => {
    const before = 'same\n';
    const a = fixture('a.ts', before);

    const r = await patch([{ file_path: a, old_string: 'same', new_string: 'same' }]);

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('no_op');
    expect(readFileSync(a, 'utf8')).toBe(before);
  });

  it('reports a file that a hunk set back to its original content as unchanged rather than written', async () => {
    const a = fixture('a.ts', 'alpha beta\n');

    const r = await patch([
      { file_path: a, old_string: 'alpha', new_string: 'gamma' },
      { file_path: a, old_string: 'gamma', new_string: 'alpha' },
    ]);

    const out = parse(r);
    expect(out.ok).toBe(true);
    expect(out.filesWritten).toBe(0);
    expect(out.unchanged).toEqual([a]);
    expect(readFileSync(a, 'utf8')).toBe('alpha beta\n');
  });
});

describe('capability:patch — per-file semantics', () => {
  it('applies several hunks to the SAME file in order', async () => {
    const a = fixture('a.ts', 'one two three\n');

    const r = await patch([
      { file_path: a, old_string: 'one', new_string: 'ONE' },
      { file_path: a, old_string: 'three', new_string: 'THREE' },
    ]);

    expect(parse(r).ok).toBe(true);
    expect(readFileSync(a, 'utf8')).toBe('ONE two THREE\n');
  });

  it('sees an earlier hunk’s output when a later hunk targets the same file', async () => {
    const a = fixture('a.ts', 'stage0\n');

    const r = await patch([
      { file_path: a, old_string: 'stage0', new_string: 'stage1' },
      // Only matches if hunk 0 was applied in memory first.
      { file_path: a, old_string: 'stage1', new_string: 'stage2' },
    ]);

    expect(parse(r).ok).toBe(true);
    expect(readFileSync(a, 'utf8')).toBe('stage2\n');
  });

  it('counts replace_all replacements per file', async () => {
    const a = fixture('a.ts', 'dup dup dup\n');

    const r = await patch([{ file_path: a, old_string: 'dup', new_string: 'x', replace_all: true }]);

    const out = parse(r) as { files: Array<{ path: string; replacements: number }> };
    expect(out.files[0].replacements).toBe(3);
    expect(readFileSync(a, 'utf8')).toBe('x x x\n');
  });

  it('accepts a path relative to the project dir', async () => {
    const name = `${seq++}-rel.ts`;
    writeFileSync(join(DIR, name), 'rel-old\n', 'utf8');

    const r = await patch([{ file_path: name, old_string: 'rel-old', new_string: 'rel-new' }]);

    expect(parse(r).ok).toBe(true);
    expect(readFileSync(join(DIR, name), 'utf8')).toBe('rel-new\n');
  });

  it('reports a missing file as a read failure without writing its siblings', async () => {
    const before = 'present\n';
    const a = fixture('a.ts', before);

    const r = await patch([
      { file_path: a, old_string: 'present', new_string: 'changed' },
      { file_path: join(DIR, 'does-not-exist.ts'), old_string: 'x', new_string: 'y' },
    ]);

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
    expect(readFileSync(a, 'utf8')).toBe(before);
  });
});

describe('capability:patch — managed authority and locks', () => {
  it('takes ONE lock covering every distinct target path, not one lock per hunk', async () => {
    const a = fixture('a.ts', 'a-old\n');
    const b = fixture('b.ts', 'b-old\n');

    await patch([
      { file_path: a, old_string: 'a-old', new_string: 'a-new' },
      { file_path: b, old_string: 'b-old', new_string: 'b-new' },
      // A second hunk on an already-listed file must NOT add a duplicate lock entry.
      { file_path: a, old_string: 'a-new', new_string: 'a-final' },
    ]);

    expect(lockedPathSets).toHaveLength(1);
    expect([...lockedPathSets[0]!].sort()).toEqual([a, b].sort());
  });

  it('locks the RESOLVED absolute path, never the raw relative argument', async () => {
    const name = `${seq++}-resolve.ts`;
    writeFileSync(join(DIR, name), 'r-old\n', 'utf8');

    await patch([{ file_path: name, old_string: 'r-old', new_string: 'r-new' }]);

    expect(lockedPathSets[0]).toEqual([join(DIR, name)]);
    expect(lockedPathSets[0]).not.toContain(name);
  });

  it('holds the lock even for the rejected-hunk path, so validation cannot race a peer', async () => {
    const a = fixture('a.ts', 'a-old\n');
    const b = fixture('b.ts', 'b-old\n');

    await patch([
      { file_path: a, old_string: 'a-old', new_string: 'a-new' },
      { file_path: b, old_string: 'NOPE', new_string: 'x' },
    ]);

    expect([...lockedPathSets[0]!].sort()).toEqual([a, b].sort());
  });

  it('declares the write capability that gates the managed door', () => {
    expect(patchTool.capability).toBe('capability:fs-write');
    expect(patchTool.name).toBe('capability:patch');
  });
});

describe('capability:patch — failure diagnosis', () => {
  it('warns that a hunk may already be applied instead of inviting a retry', async () => {
    const a = fixture('a.ts', 'already-new\n');

    const r = await patch([{ file_path: a, old_string: 'already-old', new_string: 'already-new' }]);

    expect(String(parse(r).message)).toContain('ALREADY present');
  });

  it('names a whitespace-only mismatch rather than a bare not-found', async () => {
    const a = fixture('a.ts', 'const  x   =  1;\n');

    const r = await patch([{ file_path: a, old_string: 'const x = 1;', new_string: 'const x = 2;' }]);

    expect(String(parse(r).message)).toContain('whitespace-insensitive match exists');
  });

  it('states that no file was written on a rejected hunk', async () => {
    const a = fixture('a.ts', 'z\n');

    const r = await patch([{ file_path: a, old_string: 'absent', new_string: 'q' }]);

    expect(String(parse(r).message)).toContain('No file was written.');
  });
});

describe('text-splice — the shared literal-replacement helpers', () => {
  // EI-18693907749585513: `String.prototype.replace(str, str)` still expands `$&`,
  // `` $` ``, `$'`, `$1` and `$$` in the REPLACEMENT. `` $` `` means "everything
  // before the match", which once spliced a whole file into itself. Both mutation
  // doors now share these helpers, so this control covers capability:edit too.
  it.each([
    ['$`', 'before $` after'],
    ['$&', 'x $& y'],
    ["$'", "a $' b"],
    ['$1', 'g $1 h'],
    ['$$', 'i $$ j'],
  ])('inserts %s literally instead of expanding it', (_label, replacement) => {
    expect(spliceLiteral('KEEP<TARGET>KEEP', '<TARGET>', replacement, false)).toBe(`KEEP${replacement}KEEP`);
    expect(spliceLiteral('a<TARGET>b<TARGET>c', '<TARGET>', replacement, true)).toBe(`a${replacement}b${replacement}c`);
  });

  it('replaces only the first occurrence when replaceAll is false', () => {
    expect(spliceLiteral('a-a-a', 'a', 'Z', false)).toBe('Z-a-a');
    expect(spliceLiteral('a-a-a', 'a', 'Z', true)).toBe('Z-Z-Z');
  });

  it('returns the source untouched when the needle is absent or empty', () => {
    expect(spliceLiteral('abc', 'zzz', 'Z', false)).toBe('abc');
    expect(spliceLiteral('abc', '', 'Z', true)).toBe('abc');
  });

  it('counts non-overlapping occurrences and never matches an empty needle', () => {
    expect(occurrences('aaaa', 'aa')).toBe(2);
    expect(occurrences('abc', '')).toBe(0);
    expect(occurrences('abc', 'd')).toBe(0);
  });

  it('collapses whitespace runs for near-match diagnosis', () => {
    expect(squashWhitespace('  const   x\n=\t1;  ')).toBe('const x = 1;');
  });
});

describe('capability:patch — end-to-end through the shared splice', () => {
  it('writes a replacement containing $` literally to disk', async () => {
    const a = fixture('a.md', 'quote: <HERE>\n');

    const r = await patch([{ file_path: a, old_string: '<HERE>', new_string: 'use $` for the prefix' }]);

    expect(parse(r).ok).toBe(true);
    expect(readFileSync(a, 'utf8')).toBe('quote: use $` for the prefix\n');
  });
});
