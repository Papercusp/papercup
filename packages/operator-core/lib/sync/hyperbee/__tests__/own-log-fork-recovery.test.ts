/**
 * own-log-fork-recovery.test.ts — P-003 (WI-3535).
 *
 * The sketched, flag-gated, default-OFF destructive auto-recovery for a
 * forked own-log: the `confirm:true` double-guard, the flag gate, and the
 * happy path (store-reset via the injected `rm` DI seam — NEVER the real
 * filesystem — plus clearing the in-process latch and best-effort EI
 * auto-resolve).
 *
 * `harnessStorePath` and `closeHarnessStore` (corestore.ts) are used FOR
 * REAL here (not mocked): `harnessStorePath` is a pure path computation (no
 * fs), and `closeHarnessStore` no-ops when nothing is cached for the given
 * (workspaceRoot, harnessSlug) — safe in a unit test. Only the destructive
 * `rm` step and the flag check go through explicit DI seams.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverForkedOwnLog } from '../own-log-fork-recovery';
import {
  reportOwnLogForkConflict,
  getOwnLogForkState,
  _resetOwnLogForkGuardForTests,
} from '../own-log-fork-guard';
import { harnessStorePath } from '../corestore';

const WORKSPACE_ROOT = '/tmp/own-log-fork-recovery-test';
const WS = 'ws-1';
const HS = 'harness-a';
const KEY = 'a'.repeat(64);

afterEach(() => {
  _resetOwnLogForkGuardForTests();
});

function baseOpts(overrides: Partial<Parameters<typeof recoverForkedOwnLog>[0]> = {}) {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: WS,
    harnessSlug: HS,
    keyHex: KEY,
    confirm: true as const,
    rm: vi.fn(async () => {}),
    isEnabled: vi.fn(async () => true),
    ...overrides,
  };
}

describe('recoverForkedOwnLog — guards (never touch disk unless BOTH pass)', () => {
  it('confirm !== true → not_confirmed, rm never called', async () => {
    const rm = vi.fn(async () => {});
    const isEnabled = vi.fn(async () => true);
    const result = await recoverForkedOwnLog({
      ...baseOpts(),
      // @ts-expect-error — deliberately testing the runtime guard against a bad caller
      confirm: false,
      rm,
      isEnabled,
    });
    expect(result).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(rm).not.toHaveBeenCalled();
    expect(isEnabled).not.toHaveBeenCalled(); // short-circuits before even checking the flag
  });

  it('flag off → flag_off, rm never called', async () => {
    const rm = vi.fn(async () => {});
    const result = await recoverForkedOwnLog({
      ...baseOpts(),
      rm,
      isEnabled: vi.fn(async () => false),
    });
    expect(result).toEqual({ ok: false, reason: 'flag_off' });
    expect(rm).not.toHaveBeenCalled();
  });

  it('the default isEnabled resolver is used when omitted (real @papercusp/flags path) and reads off by default, so rm is never called', async () => {
    const rm = vi.fn(async () => {});
    const result = await recoverForkedOwnLog({
      workspaceRoot: WORKSPACE_ROOT,
      workspaceId: WS,
      harnessSlug: HS,
      keyHex: KEY,
      confirm: true,
      rm,
    });
    // FLAGS.OWN_LOG_FORK_AUTO_RECOVERY is a DARK (owner-authority) flag — default OFF.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flag_off');
    expect(rm).not.toHaveBeenCalled();
  });
});

describe('recoverForkedOwnLog — happy path', () => {
  it('removes the harness store path, clears the fork latch, and reports ok:true with resetPath', async () => {
    reportOwnLogForkConflict(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, detail: 'test conflict' },
      { onEpisode: () => {} },
    );
    expect(getOwnLogForkState(WS, HS).forked).toBe(true);

    const rm = vi.fn(async () => {});
    const result = await recoverForkedOwnLog(baseOpts({ rm }));

    expect(result.ok).toBe(true);
    expect(result.resetPath).toBe(harnessStorePath({ workspaceRoot: WORKSPACE_ROOT, harnessSlug: HS }));
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(result.resetPath);

    // The registry-side latch is cleared so a future re-boot reads healthy again.
    expect(getOwnLogForkState(WS, HS).forked).toBe(false);
  });

  it('still succeeds when there was no latched fork to clear (idempotent)', async () => {
    const rm = vi.fn(async () => {});
    const result = await recoverForkedOwnLog(baseOpts({ rm }));
    expect(result.ok).toBe(true);
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('a real filesystem is NEVER touched — only the injected rm seam is called', async () => {
    // If this test ever calls the real fs/promises.rm, it would either throw (path doesn't
    // exist under a case that matters) or silently succeed against a real dir; asserting the
    // seam was used AT ALL (and exactly once) is the guard against that regression.
    const rm = vi.fn(async () => {});
    await recoverForkedOwnLog(baseOpts({ rm }));
    expect(rm).toHaveBeenCalledTimes(1);
  });

  it('propagates an rm failure (a failed reset must not silently report ok:true)', async () => {
    const rm = vi.fn(async () => {
      throw new Error('disk error');
    });
    await expect(recoverForkedOwnLog(baseOpts({ rm }))).rejects.toThrow('disk error');
  });
});
