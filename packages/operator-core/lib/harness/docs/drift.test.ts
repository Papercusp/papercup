import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSubjectRefDrift, checkDocDrift } from './drift';
import type { GitRunner } from './subject-ref';

/** Real git runner over a fixture repo — exactly the shape run-git-sync injects. */
const runGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return Promise.resolve({
      code: err.status ?? -1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    });
  }
};

let repo: string;
const shas: Record<string, string> = {};

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
function commitAll(msg: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'drift-fixture-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@papercusp.dev']);
  git(['config', 'user.name', 'Drift Test']);
  git(['config', 'commit.gpgsign', 'false']);

  // C0 — baseline: a source file with two functions + an unrelated file.
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'src/foo.ts'),
    [
      'export function alpha() {',
      '  return 1;',
      '}',
      '',
      'export function beta() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(join(repo, 'src/other.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  shas.c0 = commitAll('c0 baseline');

  // C1 — edit ONLY the body of alpha() (beta + other.ts untouched).
  writeFileSync(
    join(repo, 'src/foo.ts'),
    [
      'export function alpha() {',
      '  return 1 + 1; // changed',
      '}',
      '',
      'export function beta() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
  );
  shas.c1 = commitAll('c1 edit alpha body');

  // C2 — whitespace-only change to other.ts (trailing spaces). Documents the
  // accepted false-nudge: a pure-whitespace commit still flags path drift.
  writeFileSync(join(repo, 'src/other.ts'), 'export const x = 1;   \n');
  shas.c2 = commitAll('c2 whitespace-only on other.ts');

  // C3 — rename src/other.ts → src/renamed.ts (no content change).
  renameSync(join(repo, 'src/other.ts'), join(repo, 'src/renamed.ts'));
  shas.c3 = commitAll('c3 rename other.ts -> renamed.ts');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

const opts = () => ({ runGit, repoRoot: repo });

describe('path strategy', () => {
  it('flags stale when the watched path changed since baseline', async () => {
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, shas.c0, opts());
    expect(r.stale).toBe(true);
    expect(r.method).toBe('path');
    expect(r.changedPaths).toContain('src/foo.ts');
  });

  it('is fresh when nothing under the path changed since baseline', async () => {
    // Anchored to README.md, baseline c0 → only foo/other/renamed moved after.
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['README.md'] }, shas.c0, opts());
    expect(r.stale).toBe(false);
    expect(r.error).toBeUndefined();
  });

  it('whitespace-only commit produces a (documented, accepted) false stale', async () => {
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/other.ts'] }, shas.c1, opts());
    // c2 is whitespace-only on other.ts — we accept the false nudge over silent rot.
    expect(r.stale).toBe(true);
  });

  it('glob pathspec works (multiple files under src/**)', async () => {
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/**'] }, shas.c0, opts());
    expect(r.stale).toBe(true);
  });
});

describe('symbol strategy (precise via -L)', () => {
  it('flags when the documented function body changed', async () => {
    const r = await checkSubjectRefDrift({ kind: 'symbol', file: 'src/foo.ts', name: 'alpha' }, shas.c0, opts());
    expect(r.stale).toBe(true);
    expect(r.method).toBe('symbol');
  });

  it('does NOT flag when only an UNRELATED function in the same file changed', async () => {
    // beta() was never edited; c1 only touched alpha(). Baseline c0.
    const r = await checkSubjectRefDrift({ kind: 'symbol', file: 'src/foo.ts', name: 'beta' }, shas.c0, opts());
    expect(r.stale).toBe(false);
    expect(r.method).toBe('symbol');
  });
});

describe('rename via --follow', () => {
  it('follows a single concrete path across a rename', async () => {
    // other.ts → renamed.ts at c3. Anchored to the OLD path, baseline c2 (after
    // whitespace, before rename) — --follow should still see the rename commit.
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/other.ts'] }, shas.c2, opts());
    expect(r.stale).toBe(true);
  });
});

describe('feature strategy', () => {
  it('resolves a feature → its commit files → drift', async () => {
    // F-100 "implemented" by c1 (which touched src/foo.ts). Baseline c0.
    const resolveFeatureCommits = async (ref: string) => (ref === 'F-100' ? [shas.c1] : []);
    const r = await checkSubjectRefDrift({ kind: 'feature', ref: 'F-100' }, shas.c0, {
      ...opts(),
      resolveFeatureCommits,
    });
    expect(r.stale).toBe(true);
    expect(r.method).toBe('feature');
  });

  it('errors (not stale) when the feature has no recorded commit', async () => {
    const resolveFeatureCommits = async () => [];
    const r = await checkSubjectRefDrift({ kind: 'feature', ref: 'F-404' }, shas.c0, {
      ...opts(),
      resolveFeatureCommits,
    });
    expect(r.stale).toBe(false);
    expect(r.error).toBe('unresolved-feature');
  });
});

describe('baseline edge cases', () => {
  it('no baseline → not-tracked error, never a confident verdict', async () => {
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, '', opts());
    expect(r.stale).toBe(false);
    expect(r.error).toBe('no-baseline');
  });

  it('invalid baseline sha → error, no false stale', async () => {
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, 'not-a-sha!', opts());
    expect(r.error).toBe('invalid-baseline');
  });

  it('baseline == HEAD → fresh (empty range)', async () => {
    const head = git(['rev-parse', 'HEAD']);
    const r = await checkSubjectRefDrift({ kind: 'path', globs: ['src/foo.ts'] }, head, opts());
    expect(r.stale).toBe(false);
    expect(r.error).toBeUndefined();
  });
});

describe('checkDocDrift (multi-ref)', () => {
  it('stale if ANY ref is stale', async () => {
    const r = await checkDocDrift(
      [
        { kind: 'path', globs: ['README.md'] }, // fresh
        { kind: 'path', globs: ['src/foo.ts'] }, // stale
      ],
      shas.c0,
      opts(),
    );
    expect(r.stale).toBe(true);
  });

  it('unanchored (no refs) → error', async () => {
    const r = await checkDocDrift([], shas.c0, opts());
    expect(r.stale).toBe(false);
    expect(r.error).toBe('unanchored');
  });

  it('one clean + one errored ref → confident fresh (not error)', async () => {
    const r = await checkDocDrift(
      [
        { kind: 'path', globs: ['README.md'] }, // fresh, no error
        { kind: 'feature', ref: 'F-404' }, // errors (unresolved)
      ],
      shas.c0,
      { ...opts(), resolveFeatureCommits: async () => [] },
    );
    expect(r.stale).toBe(false);
    expect(r.error).toBeUndefined();
  });
});
