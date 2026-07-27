/**
 * WI-6282 — the GitHub-bridge leg's WI-3500 catch-up pin must not run git in a
 * store directory that does not exist yet.
 *
 * LIVE-REPRODUCED on the P-302 rig 2026-07-27: a cold joiner's first git-sync tick
 * logged `bare canonical catch-up pin failed: Error: spawn git ENOENT`. That string
 * occurred exactly once in a 30k-line log — on the first tick after the store was
 * deliberately removed, never on a warm tick.
 *
 * The trap is the ERROR TEXT, not just the failure: `hiveGitRepoPath()` only computes
 * a path (unlike `ensurePotGitRepo`, which creates), and this leg runs BEFORE the
 * bootstrap leg that does. Node reports a missing CWD as ENOENT *on the binary*, so
 * the message reads "git is not installed" — sending whoever debugs a failed join
 * after entirely the wrong thing. The cold path is the new-joiner path, so this is
 * the first message a fresh device can emit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadHarnessRegistryMock = vi.hoisted(() => vi.fn());
const hiveGitRepoPathMock = vi.hoisted(() => vi.fn());
const pathExistsMock = vi.hoisted(() => vi.fn());
const defaultRunGitMock = vi.hoisted(() => vi.fn());
/** The routines row the leg reads its watermarks from. A non-null `wb_sha` is what
 *  arms the catch-up pin at all — without it the pin is skipped for an unrelated
 *  reason and the test would pass vacuously. */
const sqlMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryMock,
}));
// Partial: unrelated modules pulled in transitively (locks/configure.ts) call other
// db-org exports at import time, and vitest throws on ANY access to a missing mock key.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock, unsafe: vi.fn() }),
}));
vi.mock('../../sync/pot-git/storage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hiveGitRepoPath: hiveGitRepoPathMock,
  pathExists: pathExistsMock,
  defaultRunGit: defaultRunGitMock,
}));

import { runGithubBridgeLeg } from './git-sync-action';

const SLUG = 'shop-hive';
const WS = 'ws-1';
const BARE = '/repos/shop-hive/shop-hive.git';

/** Did the leg spawn git against the bare store? That — not the log text — is the
 *  behaviour under test: on a cold device the spawn itself is what dies. */
const gitRanAgainstStore = () =>
  defaultRunGitMock.mock.calls.some((c) => c[1] === BARE);

beforeEach(() => {
  vi.clearAllMocks();
  loadHarnessRegistryMock.mockResolvedValue({
    projects: [{ slug: SLUG, hive_slug: SLUG, self_repo: true }],
  });
  hiveGitRepoPathMock.mockReturnValue(BARE);
  // wb_sha present ⇒ the pin is armed. prev_egress_head/last_admitted are irrelevant here.
  sqlMock.mockResolvedValue([{ la: null, wb_sha: 'a'.repeat(40), prev_egress_head: null }]);
  defaultRunGitMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
});

describe('runGithubBridgeLeg — WI-6282 cold-store catch-up pin', () => {
  it('does NOT spawn git when the bare store does not exist yet (the cold-joiner case)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(false); // cold device: nothing created it yet
      await expect(runGithubBridgeLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(gitRanAgainstStore()).toBe(false);
      // and specifically never the two pin commands
      const argv0s = defaultRunGitMock.mock.calls.map((c) => (c[0] as string[])[0]);
      expect(argv0s).not.toContain('rev-parse');
      expect(argv0s).not.toContain('update-ref');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('DOES pin on a warm store — the guard skips the cold case only, it does not disable the pin', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      // rev-parse non-zero = canonical ref absent = the pin has work to do.
      defaultRunGitMock.mockImplementation(async (args: string[]) =>
        (args[0] === 'rev-parse' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      );
      await runGithubBridgeLeg(SLUG, WS);
      const argv0s = defaultRunGitMock.mock.calls.map((c) => (c[0] as string[])[0]);
      expect(argv0s).toContain('rev-parse');
      expect(argv0s).toContain('update-ref');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('names the PATH when a warm-store pin genuinely fails (the original message had none)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pathExistsMock.mockResolvedValue(true);
      defaultRunGitMock.mockImplementation(async (args: string[]) =>
        args[0] === 'rev-parse'
          ? { code: 1, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'some git failure' },
      );
      await runGithubBridgeLeg(SLUG, WS);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('catch-up pin failed'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(BARE));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
