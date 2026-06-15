/**
 * viewer-identity.test.ts — getViewerOwnerEmail resolves the viewer's plan-owner
 * identity from `git config user.email`: lowercased + trimmed, cached once per
 * process, fail-soft to null when git is absent/unconfigured (deployed frame).
 * Exercises the previously-unused __resetViewerIdentityForTests seam.
 *
 * execFile is mocked (same pattern as preflight-binaries.test.ts) so the test is
 * deterministic + offline and never shells out to the real git.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileImpl = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    execFileImpl(file, args, opts, cb),
}));

import { getViewerOwnerEmail, __resetViewerIdentityForTests } from './viewer-identity';

/** `git config user.email` succeeds with the given stdout. */
function gitEmail(stdout: string) {
  execFileImpl.mockImplementation(
    (_f: string, _a: unknown, _o: unknown, cb: (e: Error | null, r?: unknown) => void) =>
      cb(null, { stdout }),
  );
}
/** git is absent / unconfigured → the probe rejects (e.g. ENOENT). */
function gitFails() {
  execFileImpl.mockImplementation(
    (_f: string, _a: unknown, _o: unknown, cb: (e: Error | null, r?: unknown) => void) =>
      cb(new Error('git: command not found')),
  );
}

beforeEach(() => {
  execFileImpl.mockReset();
  __resetViewerIdentityForTests();
});

describe('getViewerOwnerEmail', () => {
  it('returns the git email lowercased + trimmed', async () => {
    gitEmail('  User@Example.COM\n');
    expect(await getViewerOwnerEmail()).toBe('user@example.com');
  });

  it('invokes `git config user.email`', async () => {
    gitEmail('me@foo.io\n');
    await getViewerOwnerEmail();
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    const [file, args] = execFileImpl.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['config', 'user.email']);
  });

  it('returns null when git output is empty', async () => {
    gitEmail('');
    expect(await getViewerOwnerEmail()).toBeNull();
  });

  it('returns null when git output is whitespace-only', async () => {
    gitEmail('   \n\t');
    expect(await getViewerOwnerEmail()).toBeNull();
  });

  it('returns null (fail-soft) when git is absent / unconfigured', async () => {
    gitFails();
    expect(await getViewerOwnerEmail()).toBeNull();
  });

  it('resolves once and caches the result for the whole process', async () => {
    gitEmail('cached@me.dev\n');
    expect(await getViewerOwnerEmail()).toBe('cached@me.dev');
    // A second call must NOT re-shell to git — it returns the memoized promise.
    gitFails(); // would yield null if the cache were bypassed
    expect(await getViewerOwnerEmail()).toBe('cached@me.dev');
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('__resetViewerIdentityForTests drops the cache so the next call re-resolves', async () => {
    gitEmail('first@me.dev\n');
    expect(await getViewerOwnerEmail()).toBe('first@me.dev');
    __resetViewerIdentityForTests();
    gitEmail('second@me.dev\n');
    expect(await getViewerOwnerEmail()).toBe('second@me.dev');
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });
});
