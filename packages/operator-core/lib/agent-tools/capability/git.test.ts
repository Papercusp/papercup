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
import { runGit } from './git';

const STATE = mkdtempSync(join(tmpdir(), 'cap-git-'));
const never = new AbortController().signal;

describe('runGit', () => {
  it('runs a plain git subcommand', async () => {
    const r = await runGit(['--version'], STATE, STATE, never);
    expect(r.code).toBe(0);
    expect(r.output).toContain('git version');
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
