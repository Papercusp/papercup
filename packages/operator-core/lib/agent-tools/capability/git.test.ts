/**
 * Unit tests for capability:git's runGit spawn (P-010; EI-1617 env-scrub fix).
 *
 * runGit spawns the real `git` binary directly (no shell), so an env-leak
 * regression test can't just `printf "$SECRET"`. Git's `!`-prefixed custom
 * aliases DO run through a shell, though (`git -c alias.x='!cmd' x`), which
 * gives an honest end-to-end probe of the CHILD PROCESS's actual env without
 * mocking anything — the exact vector a bee's `capability:git` would have had.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyPathspecNote, runGit } from './git';

const STATE = mkdtempSync(join(tmpdir(), 'cap-git-'));
const never = new AbortController().signal;

describe('runGit', () => {
  it('runs a plain git subcommand', async () => {
    const r = await runGit(['--version'], STATE, STATE, never);
    expect(r.code).toBe(0);
    expect(r.output).toContain('git version');
  });
});

/**
 * EI-20881501070735530 — `git … -- <pathspec>` that matches nothing prints nothing and
 * exits 0, which is byte-identical to a genuine "no commits touch this file". The cwd
 * bug that produced the original false absence is fixed, but the ambiguous SHAPE is
 * git's, not ours, so the tool names which reading it cannot distinguish.
 *
 * The teeth are in the negatives: a note on a legitimately-empty `git diff` would train
 * agents to ignore it, which is worse than not having it.
 */
describe('emptyPathspecNote — the empty-at-exit-0 pathspec ambiguity', () => {
  const CWD = '/tree';

  it('fires when an explicit -- pathspec produced nothing at exit 0', () => {
    const note = emptyPathspecNote(['log', '-3', '--', 'pkg/a.ts'], 0, '', CWD);
    expect(note).toContain('pathspec matched nothing');
    expect(note).toContain('pkg/a.ts');
    expect(note).toContain(CWD); // the cwd IS the disambiguator — never omit it
  });

  it('does NOT fire on a clean `git diff` — an empty result there is the true answer', () => {
    expect(emptyPathspecNote(['diff', '--stat'], 0, '', CWD)).toBe('');
  });

  it('does NOT fire when the command produced output', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 0, 'abc123 subject\n', CWD)).toBe('');
  });

  it('does NOT fire on a non-zero exit — git already said what went wrong', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 128, '', CWD)).toBe('');
  });

  it('does NOT fire on a bare `--` with no operands', () => {
    expect(emptyPathspecNote(['log', '--'], 0, '', CWD)).toBe('');
  });

  it('names the submodule case — the one where the path exists but can never match', () => {
    expect(emptyPathspecNote(['log', '--', 'libs/papercusp-shared/package.json'], 0, '', CWD))
      .toContain('SUBMODULE');
  });
});

describe('operator secrets are NOT inherited by the git subprocess (EI-1617)', () => {
  it('a fake operator secret in process.env never reaches a git shell-alias command', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user:pw@host/db-should-not-leak';
    try {
      const r = await runGit(
        ['-c', 'alias.leak=!printf "[%s]" "${DATABASE_URL:-unset}"', 'leak'],
        STATE,
        STATE,
        never,
      );
      expect(r.code).toBe(0);
      expect(r.output).toBe('[unset]');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('a plain allowlisted var (PATH) still reaches the git shell-alias command', async () => {
    const r = await runGit(
      ['-c', 'alias.leak=!test -n "$PATH" && printf has-path', 'leak'],
      STATE,
      STATE,
      never,
    );
    expect(r.code).toBe(0);
    expect(r.output).toBe('has-path');
  });
});
