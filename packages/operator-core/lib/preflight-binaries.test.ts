/**
 * preflight-binaries.test.ts — the claude/omp detection probes shared
 * by /api/desktop/preflight + /api/desktop/setup-status (they must agree).
 *
 * Contract: a probe is "on PATH first, then bundled-candidate paths (only if the
 * file exists AND `--version` succeeds)", and every probe is fail-soft (a missing
 * binary → false, never a throw). execFile + existsSync are mocked so the test is
 * deterministic + offline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileImpl = vi.fn();
const existsSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    execFileImpl(file, args, opts, cb),
}));
vi.mock('node:fs', () => ({ existsSync: (p: string) => existsSyncMock(p) }));

import { detectClaude, detectOmp } from './preflight-binaries';

/** Only the given paths answer `--version` successfully; all others "fail". */
function probeSucceedsFor(...paths: string[]) {
  const set = new Set(paths);
  execFileImpl.mockImplementation((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (set.has(file)) cb(null, { stdout: 'v1.2.3\n' });
    else cb(new Error('ENOENT'));
  });
}
/** Only the given paths "exist" on disk. */
function pathsExist(...paths: string[]) {
  const set = new Set(paths);
  existsSyncMock.mockImplementation((p: string) => set.has(p));
}

const CLAUDE_CANDIDATE = `${process.env.HOME ?? ''}/.local/bin/claude`;

beforeEach(() => {
  execFileImpl.mockReset();
  existsSyncMock.mockReset();
  pathsExist(); // nothing exists by default
});

describe('detectClaude', () => {
  it('returns true when `claude` is on PATH (no candidate lookups needed)', async () => {
    probeSucceedsFor('claude');
    expect(await detectClaude()).toBe(true);
  });

  it('falls back to a candidate path that exists AND probes ok', async () => {
    probeSucceedsFor(CLAUDE_CANDIDATE); // not on PATH, but the candidate works
    pathsExist(CLAUDE_CANDIDATE);
    expect(await detectClaude()).toBe(true);
  });

  it('returns false when a candidate exists but its probe fails (fail-soft, no throw)', async () => {
    probeSucceedsFor(/* nothing succeeds */);
    pathsExist(CLAUDE_CANDIDATE); // exists on disk but `--version` throws
    await expect(detectClaude()).resolves.toBe(false);
  });

  it('returns false when nothing is on PATH and no candidate exists', async () => {
    probeSucceedsFor();
    expect(await detectClaude()).toBe(false);
  });
});

describe('detectOmp', () => {
  it('returns true when `omp` is on PATH', async () => {
    probeSucceedsFor('omp');
    expect(await detectOmp()).toBe(true);
  });

  it('returns false when omp is absent everywhere', async () => {
    probeSucceedsFor();
    expect(await detectOmp()).toBe(false);
  });
});
