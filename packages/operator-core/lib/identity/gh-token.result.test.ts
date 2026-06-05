/**
 * gh-token — PURE result-shape + error-classification + cache tests for
 * `getGhAuthToken` / `refreshGhAuthToken`, exercised with a mocked
 * `child_process.execFile`.
 *
 * The sibling `gh-token.test.ts` covers the `parseScopesFromGhStatus`
 * parser and a real-`gh` integration smoke (skipped without auth). This
 * file covers the token-resolution control flow that the smoke can't pin
 * deterministically:
 *
 *   - `{ kind: 'ok', token }` on a non-empty `gh auth token` stdout;
 *   - in-process cache: a second `getGhAuthToken` does NOT re-shell;
 *   - `refreshGhAuthToken` ALWAYS re-shells (invalidates first);
 *   - empty/whitespace stdout → `{ kind: 'error', { kind: 'not_authenticated' } }`;
 *   - error classification via the thrown exec error message:
 *       ENOENT / "command not found"        → gh_cli_missing
 *       "not logged in" / "no auth token"   → not_authenticated
 *       anything else                       → gh_cli_failed{reason}
 *   - the helper never throws and never returns the token on the error path.
 *
 * The source resolves the token through `gh auth token` ONLY — there is no
 * env-var or file fallback in this implementation. (See the suite-level note
 * in the test report: the brief's "env/file/gh-cli fallback order" describes
 * a richer resolver than the one in gh-token.ts.)
 *
 * Mock mechanics: the source does `promisify(execFile)` where `execFile` is
 * the named import from `node:child_process`. Node's real `child_process.execFile`
 * carries a `util.promisify.custom` symbol that yields `{stdout, stderr}`; a
 * plain callback mock would instead resolve to just `stdout`. So the mock
 * attaches that custom symbol with an async impl returning `{stdout, stderr}`
 * (or throwing), matching the shape the source destructures.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { promisify } from 'node:util';

// Per-test scripted exec behavior. `impl` is the promisified form:
//   async (file, args, opts) => ({ stdout, stderr })  | throws
let execImpl: (file: string, args: string[], opts: unknown) => Promise<{ stdout: string; stderr: string }>;

vi.mock('node:child_process', () => {
  const CUSTOM = promisify.custom;
  // The named export the source imports. Calls delegate to the current
  // `execImpl`; the custom symbol makes `promisify(execFile)` use it directly.
  const execFile = ((..._a: unknown[]) => {
    throw new Error('callback form not used in these tests');
  }) as unknown as { [k: symbol]: unknown };
  execFile[CUSTOM] = (file: string, args: string[], opts: unknown) => execImpl(file, args, opts);
  return { execFile };
});

import {
  getGhAuthToken,
  refreshGhAuthToken,
  clearGhAuthTokenCache,
} from './gh-token';

/** Script the next exec to resolve with this stdout (stderr empty). */
function scriptOk(stdout: string) {
  const fn = vi.fn(async () => ({ stdout, stderr: '' }));
  execImpl = fn;
  return fn;
}
/** Script the next exec to reject with an Error carrying `message`. */
function scriptThrow(message: string) {
  const fn = vi.fn(async () => {
    throw new Error(message);
  });
  execImpl = fn as never;
  return fn;
}

beforeEach(() => {
  clearGhAuthTokenCache();
  execImpl = async () => ({ stdout: '', stderr: '' });
});

describe('getGhAuthToken — ok result', () => {
  it('returns { kind: "ok", token } with the trimmed stdout', async () => {
    scriptOk('gho_abc123\n');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'ok', token: 'gho_abc123' });
  });

  it('caches the token — a second call does NOT re-shell', async () => {
    const exec = scriptOk('gho_cached\n');
    const a = await getGhAuthToken();
    expect(a).toEqual({ kind: 'ok', token: 'gho_cached' });
    // Re-point exec at a different value; cache should win and exec stays at 1 call.
    scriptOk('gho_DIFFERENT\n');
    const b = await getGhAuthToken();
    expect(b).toEqual({ kind: 'ok', token: 'gho_cached' });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('refreshGhAuthToken — always re-shells + invalidates first', () => {
  it('bypasses the cache and returns the freshly-read token', async () => {
    scriptOk('gho_first\n');
    await getGhAuthToken(); // primes cache with gho_first
    const exec2 = scriptOk('gho_second\n');
    const r = await refreshGhAuthToken();
    expect(r).toEqual({ kind: 'ok', token: 'gho_second' });
    expect(exec2).toHaveBeenCalledTimes(1);
    // And the new value is now the cached one.
    scriptOk('gho_third\n');
    const cached = await getGhAuthToken();
    expect(cached).toEqual({ kind: 'ok', token: 'gho_second' });
  });
});

describe('getGhAuthToken — empty stdout → not_authenticated', () => {
  it('empty stdout yields a not_authenticated error (token not present)', async () => {
    scriptOk('');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'not_authenticated' } });
  });

  it('whitespace-only stdout is treated as empty', async () => {
    scriptOk('   \n  ');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'not_authenticated' } });
  });

  it('an empty-token result is NOT cached — the next call re-shells', async () => {
    const exec1 = scriptOk('');
    await getGhAuthToken();
    expect(exec1).toHaveBeenCalledTimes(1);
    const exec2 = scriptOk('gho_now_authed\n');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'ok', token: 'gho_now_authed' });
    expect(exec2).toHaveBeenCalledTimes(1);
  });
});

describe('classifyGhError — via the thrown exec error', () => {
  it('ENOENT → gh_cli_missing', async () => {
    scriptThrow('spawn gh ENOENT');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'gh_cli_missing' } });
  });

  it('"command not found" → gh_cli_missing', async () => {
    scriptThrow('/bin/sh: gh: command not found');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'gh_cli_missing' } });
  });

  it('"not logged in" → not_authenticated', async () => {
    scriptThrow('You are not logged into any GitHub hosts. Run gh auth login.');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'not_authenticated' } });
  });

  it('"no auth token" → not_authenticated', async () => {
    scriptThrow('no auth token found for github.com');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'error', error: { kind: 'not_authenticated' } });
  });

  it('an unrecognized failure → gh_cli_failed carrying the message', async () => {
    scriptThrow('process exited with code 7: weird internal failure');
    const r = await getGhAuthToken();
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error.kind).toBe('gh_cli_failed');
      if (r.error.kind === 'gh_cli_failed') {
        expect(r.error.reason).toContain('weird internal failure');
      }
    }
  });

  it('never throws and never leaks a token on the error path', async () => {
    scriptThrow('spawn gh ENOENT');
    const r = await getGhAuthToken();
    expect(r.kind).toBe('error');
    expect(JSON.stringify(r)).not.toMatch(/gho_|ghp_|ghs_/);
  });

  it('an error result is NOT cached — the next call re-shells and can succeed', async () => {
    scriptThrow('spawn gh ENOENT');
    await getGhAuthToken();
    const exec2 = scriptOk('gho_recovered\n');
    const r = await getGhAuthToken();
    expect(r).toEqual({ kind: 'ok', token: 'gho_recovered' });
    expect(exec2).toHaveBeenCalledTimes(1);
  });
});
