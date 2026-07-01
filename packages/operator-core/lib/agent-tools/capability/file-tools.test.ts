/**
 * Unit tests for the capability file tools (P-010, B-05): read / write / edit.
 * Uses temp paths OUTSIDE any git repo, so the file lock is uncoordinated and
 * guardFileLock runs the body directly (no PG) — the lock control-flow itself
 * is covered in locks/file-lock-guard.test.ts.
 *
 * The "outside any git repo" guarantee comes from `mkNonRepoTmpDir`, NOT a raw
 * `mkdtempSync(os.tmpdir())`: when the suite runner's TMPDIR resolves inside this
 * monorepo, a bare os.tmpdir() temp dir has the monorepo `.git` as an ancestor,
 * so guardFileLock treats the path as coordinated and tries to resolve identity
 * (no identity on the test ctx → throws). That is EI-5826 (the EI-5541 class).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import readTool from './read';
import writeTool from './write';
import editTool from './edit';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';

const DIR = mkNonRepoTmpDir('cap-file-');
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

describe('capability:read', () => {
  it('returns numbered lines', async () => {
    const f = join(DIR, 'r.txt');
    writeFileSync(f, 'alpha\nbravo\ncharlie\n');
    const r = (await readTool.handler!({ file_path: f }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('alpha');
    expect(text).toMatch(/\s+1\talpha/);
    expect(text).toMatch(/\s+3\tcharlie/);
  });

  it('honors offset + limit', async () => {
    const f = join(DIR, 'r2.txt');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = (await readTool.handler!({ file_path: f, offset: 4, limit: 2 }, ctx)) as { content: Array<{ text: string }> };
    const text = r.content[0].text;
    expect(text).toContain('line4');
    expect(text).toContain('line5');
    expect(text).not.toContain('line6');
    expect(text).toContain('more lines');
  });

  it('errors on a missing file', async () => {
    const r = (await readTool.handler!({ file_path: join(DIR, 'nope.txt') }, ctx)) as { content: Array<{ text: string }>; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('read_failed');
  });
});

describe('capability:write', () => {
  it('creates a file', async () => {
    const f = join(DIR, 'sub/w.txt');
    const r = (await writeTool.handler!({ file_path: f, content: 'hi there\n' }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('hi there\n');
  });
});

describe('capability:edit', () => {
  it('replaces a unique string', async () => {
    const f = join(DIR, 'e.txt');
    writeFileSync(f, 'const x = 1;\nconst y = 2;\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(r).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('const x = 42;');
  });

  it('errors when old_string is absent', async () => {
    const f = join(DIR, 'e2.txt');
    writeFileSync(f, 'hello\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'missing', new_string: 'x' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('not_found');
  });

  it('errors on a non-unique match unless replace_all', async () => {
    const f = join(DIR, 'e3.txt');
    writeFileSync(f, 'dup\ndup\n');
    const bad = (await editTool.handler!({ file_path: f, old_string: 'dup', new_string: 'x' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(parse(bad).reason).toBe('not_unique');

    const ok = (await editTool.handler!({ file_path: f, old_string: 'dup', new_string: 'x', replace_all: true }, ctx)) as { content: Array<{ text: string }> };
    expect(parse(ok).ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('x\nx\n');
  });

  it('rejects a no-op edit', async () => {
    const f = join(DIR, 'e4.txt');
    writeFileSync(f, 'same\n');
    const r = (await editTool.handler!({ file_path: f, old_string: 'same', new_string: 'same' }, ctx)) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(parse(r).reason).toBe('no_op');
  });
});
