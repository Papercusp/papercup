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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('capability:patch — whole files in the same unit', () => {
  it('creates several new files and changes an existing one in ONE call, under one lock', async () => {
    const caller = fixture('caller.ts', 'import { old } from "./old";\nold();\n');
    const module = join(DIR, `${seq++}-pkg`, 'deep', 'wrap.ts');
    const tests = join(DIR, `${seq++}-pkg`, 'wrap.test.ts');

    const r = await patch([
      { file_path: module, content: 'export function wrap() {}\n' },
      { file_path: tests, content: 'import { wrap } from "./deep/wrap";\n' },
      { file_path: caller, old_string: 'old();', new_string: 'wrap();' },
    ]);

    expect(r.isError).toBeFalsy();
    const body = parse(r);
    expect(body).toMatchObject({ ok: true, hunks: 3, filesLocked: 3, filesWritten: 3, filesCreated: 2 });
    // The missing parent directories were made, and each file holds exactly what was sent.
    expect(readFileSync(module, 'utf8')).toBe('export function wrap() {}\n');
    expect(readFileSync(tests, 'utf8')).toBe('import { wrap } from "./deep/wrap";\n');
    expect(readFileSync(caller, 'utf8')).toBe('import { old } from "./old";\nwrap();\n');
    expect((body.files as Array<{ path: string; created?: boolean }>).filter((f) => f.created).map((f) => f.path).sort())
      .toEqual([module, tests].sort());
    expect(lockedPathSets).toHaveLength(1);
    expect([...lockedPathSets[0]!].sort()).toEqual([module, tests, caller].sort());
  });

  it('creates NO file when a later change does not match: the new files are not left behind', async () => {
    const existing = fixture('existing.ts', 'keep\n');
    const fresh = join(DIR, `${seq++}-never-created.ts`);

    const r = await patch([
      { file_path: fresh, content: 'new\n' },
      { file_path: existing, old_string: 'NOT THERE', new_string: 'x' },
    ]);

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('hunk_not_found');
    expect(existsSync(fresh)).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe('keep\n');
  });

  it('replaces the whole of an existing file, and a later change in the same call sees the new text', async () => {
    const f = fixture('whole.ts', 'one\ntwo\n');

    const r = await patch([
      { file_path: f, content: 'alpha\nbeta\n' },
      { file_path: f, old_string: 'beta', new_string: 'gamma' },
    ]);

    expect(r.isError).toBeFalsy();
    expect(readFileSync(f, 'utf8')).toBe('alpha\ngamma\n');
    expect(parse(r)).toMatchObject({ filesWritten: 1, filesCreated: 0 });
  });

  it('refuses a change to a file that does not exist, and says how to create it', async () => {
    const sibling = fixture('sibling.ts', 'present\n');
    const missing = join(DIR, `${seq++}-missing.ts`);

    const r = await patch([
      { file_path: sibling, old_string: 'present', new_string: 'changed' },
      { file_path: missing, old_string: 'x', new_string: 'y' },
    ]);

    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
    expect(String(parse(r).message)).toContain('give its whole text as content');
    expect(readFileSync(sibling, 'utf8')).toBe('present\n');
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses an entry that is neither a whole file nor a change, or is both, before touching anything', async () => {
    const f = fixture('shape.ts', 'body\n');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['both forms', { file_path: f, content: 'x\n', old_string: 'body', new_string: 'x' }],
      ['content with replace_all', { file_path: f, content: 'x\n', replace_all: true }],
      ['old_string alone', { file_path: f, old_string: 'body' }],
      ['new_string alone', { file_path: f, new_string: 'x' }],
      ['a path alone', { file_path: f }],
    ];
    const accepted: string[] = [];
    for (const [name, entry] of cases) {
      const r = await patch([entry]);
      if (!r.isError || parse(r).reason !== 'invalid_entry') accepted.push(name);
    }
    expect(accepted).toEqual([]);
    expect(readFileSync(f, 'utf8')).toBe('body\n');
    // Refused before the lock: nothing was read, so nothing needed holding.
    expect(lockedPathSets).toHaveLength(0);
  });

  it('holds a whole file to capability:write\'s own refusals, and writes nothing beside it', async () => {
    const full = fixture('full.ts', 'do not lose me\n');
    const other = fixture('other.ts', 'other\n');
    const view = `${full} (4 lines)\n     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour`;

    const emptied = await patch([
      { file_path: other, old_string: 'other', new_string: 'changed' },
      { file_path: full, content: '' },
    ]);
    const displayed = await patch([{ file_path: full, content: view }]);
    const globbed = await patch([{ file_path: join(DIR, 'src', '*.ts'), content: 'x\n' }]);

    expect(parse(emptied).reason).toBe('empty_overwrite_refused');
    expect(parse(displayed).reason).toBe('display_formatted_content');
    expect(parse(globbed).reason).toBe('invalid_path');
    expect(readFileSync(full, 'utf8')).toBe('do not lose me\n');
    expect(readFileSync(other, 'utf8')).toBe('other\n');
    // A new empty file destroys nothing and is allowed, as capability:write allows it.
    const marker = join(DIR, `${seq++}-py.typed`);
    expect((await patch([{ file_path: marker, content: '' }])).isError).toBeFalsy();
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('removes a file it created, and restores one it changed, when a later write fails', async () => {
    const changed = fixture('rollback-changed.ts', 'before\n');
    const made = join(DIR, `${seq++}-rollback-made.ts`);
    // A folder nothing can be written into: the third write fails after two have landed.
    const sealed = join(DIR, `${seq++}-sealed`);
    mkdirSync(sealed);
    chmodSync(sealed, 0o555);
    try {
      const r = await patch([
        { file_path: changed, old_string: 'before', new_string: 'after' },
        { file_path: made, content: 'made\n' },
        { file_path: join(sealed, 'blocked.ts'), content: 'blocked\n' },
      ]);

      expect(r.isError).toBe(true);
      const body = parse(r);
      expect(body.reason).toBe('write_failed');
      expect((body.rolledBack as string[]).sort()).toEqual([changed, made].sort());
      expect(body.rollbackFailed).toEqual([]);
      expect(readFileSync(changed, 'utf8')).toBe('before\n');
      expect(existsSync(made)).toBe(false);
      expect(existsSync(join(sealed, 'blocked.ts'))).toBe(false);
    } finally {
      chmodSync(sealed, 0o755);
    }
  });

  it('says in its own text that it writes whole files, so a caller reaches for it to create them', () => {
    // An agent picks a tool by this text: before whole files it read as a tool for changes only.
    expect(patchTool.description).toContain('whole file');
    expect(patchTool.description).toContain('creates it');
    expect(patchTool.guidance?.when).toContain('new files');
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
