/**
 * runOwnLogForkRecovery — EI-21150671414510762.
 *
 * The orchestration behind dev:own_log_fork_recover. Every side effect goes
 * through an injected seam, so nothing here touches a real store, flag or
 * substrate. The last block runs the REAL `recoverForkedOwnLog` primitive
 * (as own-log-fork-recovery.test.ts does) to prove the retire seam is what
 * its destructive step actually calls: the store is moved aside, never `rm`-ed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runOwnLogForkRecovery,
  type RunOwnLogForkRecoveryDeps,
} from '../own-log-fork-recovery';
import {
  _resetOwnLogForkGuardForTests,
  getOwnLogForkState,
  reportOwnLogForkConflict,
  type OwnLogForkState,
} from '../own-log-fork-guard';
import { harnessStorePath } from '../corestore';

const WS = 'ws-run';
const HS = 'hello-world-3-pot';
const ROOT = '/tmp/own-log-fork-run-test/ws-run';
const KEY = 'f417b935852af51e7bdf676effa8a29f59e7db23413690521c5d39810e8c087a';
const NOW = Date.parse('2026-09-23T04:10:00.000Z');

const FORKED: OwnLogForkState = { forked: true, keyHex: KEY, detectedAtMs: 1, detail: 'conflict' };
const HEALTHY: OwnLogForkState = { forked: false, keyHex: null, detectedAtMs: null, detail: null };

afterEach(() => {
  _resetOwnLogForkGuardForTests();
});

function deps(over: Partial<RunOwnLogForkRecoveryDeps> = {}) {
  const calls: string[] = [];
  const d = {
    getForkState: vi.fn(() => FORKED),
    isSubstrateOwner: vi.fn(() => true),
    workspaceRoot: vi.fn(() => ROOT),
    closeBootedHarness: vi.fn(async () => {
      calls.push('close');
      return true;
    }),
    retireStore: vi.fn(async (from: string, to: string) => {
      calls.push(`retire:${from}->${to}`);
    }),
    reboot: vi.fn(async () => {
      calls.push('reboot');
      return { closed: false, boot: { status: 'booted' } };
    }),
    isEnabled: vi.fn(async () => true),
    recover: vi.fn(async (opts: { rm?: (p: string) => Promise<void> }) => {
      await opts.rm?.(harnessStorePath({ workspaceRoot: ROOT, harnessSlug: HS }));
      return { ok: true, resetPath: 'x' };
    }),
    now: () => NOW,
    ...over,
  } satisfies RunOwnLogForkRecoveryDeps;
  return { d, calls };
}

const STORE = harnessStorePath({ workspaceRoot: ROOT, harnessSlug: HS });
// WI-10002600: the FULL forked key, because boot reads it back from this name
// to announce the old log as superseded.
const RETIRE_TO = `${STORE}.forked-f417b935852af51e7bdf676effa8a29f59e7db23413690521c5d39810e8c087a-2026-09-23T04-10-00-000Z`;

describe('runOwnLogForkRecovery — dry run is the default', () => {
  it('without confirm it reports the plan and touches nothing, even when every precondition holds', async () => {
    const { d, calls } = deps();
    const r = await runOwnLogForkRecovery({ workspaceId: WS, harnessSlug: HS, keyHex: KEY }, d);
    expect(r.outcome).toBe('dry_run');
    if (r.outcome !== 'dry_run') throw new Error('unreachable');
    expect(r.blockers).toEqual([]);
    expect(r.plan).toMatchObject({
      forkedKeyHex: KEY,
      storePath: STORE,
      retireTo: RETIRE_TO,
      flagEnabled: true,
      substrateOwner: true,
    });
    expect(calls).toEqual([]);
    expect(d.recover).not.toHaveBeenCalled();
  });

  it('lists every blocker at once so one dry run shows everything to fix', async () => {
    const { d } = deps({ isSubstrateOwner: () => false, isEnabled: async () => false });
    const r = await runOwnLogForkRecovery({ workspaceId: WS, harnessSlug: HS }, d);
    if (r.outcome !== 'dry_run') throw new Error(`expected dry_run, got ${r.outcome}`);
    expect(r.blockers).toEqual(['key_required', 'not_substrate_owner', 'flag_off']);
    expect(r.blockerDetail).toHaveLength(3);
  });
});

describe('runOwnLogForkRecovery — refusals never touch the store', () => {
  const cases: Array<[string, Partial<RunOwnLogForkRecoveryDeps>, string | undefined, string]> = [
    ['no fork recorded', { getForkState: () => HEALTHY }, KEY, 'not_forked'],
    ['no keyHex named', {}, undefined, 'key_required'],
    ['a different key named', {}, 'b'.repeat(64), 'key_mismatch'],
    ['not the substrate owner', { isSubstrateOwner: () => false }, KEY, 'not_substrate_owner'],
    ['kill-switch flag off', { isEnabled: async () => false }, KEY, 'flag_off'],
  ];
  for (const [label, over, keyHex, reason] of cases) {
    it(`${label} ⇒ refused:${reason}`, async () => {
      const { d, calls } = deps(over);
      const r = await runOwnLogForkRecovery(
        { workspaceId: WS, harnessSlug: HS, keyHex, confirm: true },
        d,
      );
      expect(r.outcome).toBe('refused');
      if (r.outcome !== 'refused') throw new Error('unreachable');
      expect(r.reason).toBe(reason);
      expect(r.detail.length).toBeGreaterThan(20);
      expect(calls).toEqual([]);
      expect(d.recover).not.toHaveBeenCalled();
    });
  }

  it('matches keyHex case-insensitively', async () => {
    const { d } = deps();
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY.toUpperCase(), confirm: true },
      d,
    );
    expect(r.outcome).toBe('recovered');
  });
});

describe('runOwnLogForkRecovery — execution', () => {
  it('closes the booted handle BEFORE the store is retired, then boots fresh', async () => {
    const { d, calls } = deps();
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true },
      d,
    );
    expect(r.outcome).toBe('recovered');
    expect(calls).toEqual(['close', `retire:${STORE}->${RETIRE_TO}`, 'reboot']);
    expect(d.reboot).toHaveBeenCalledWith(WS, HS, { workspaceRoot: ROOT });
    expect(d.recover).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: ROOT, workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true }),
    );
  });

  it('a failed retire still re-boots, so the harness is never left closed', async () => {
    const { d, calls } = deps({
      retireStore: async () => {
        throw new Error('EXDEV: cross-device link not permitted');
      },
    });
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true },
      d,
    );
    expect(r.outcome).toBe('failed');
    if (r.outcome !== 'failed') throw new Error('unreachable');
    expect(r.stage).toBe('retire');
    expect(r.error).toContain('EXDEV');
    expect(calls).toEqual(['close', 'reboot']);
  });

  it('a primitive that refuses after the handle closed is reported as failed and still re-boots', async () => {
    const { d, calls } = deps({ recover: vi.fn(async () => ({ ok: false, reason: 'flag_off' as const })) });
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true },
      d,
    );
    expect(r.outcome).toBe('failed');
    if (r.outcome !== 'failed') throw new Error('unreachable');
    expect(r.error).toContain('flag_off');
    expect(calls).toEqual(['close', 'reboot']);
  });

  it('a reboot rejection is captured in the result, not thrown', async () => {
    const { d } = deps({
      reboot: async () => {
        throw new Error('boot timed out');
      },
    });
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true },
      d,
    );
    expect(r.outcome).toBe('recovered');
    if (r.outcome !== 'recovered') throw new Error('unreachable');
    expect(r.reboot).toEqual({ error: 'boot timed out' });
  });
});

describe('runOwnLogForkRecovery — with the REAL recoverForkedOwnLog primitive', () => {
  it('routes the destructive step to retireStore (move aside, never rm) and clears the fork latch', async () => {
    reportOwnLogForkConflict(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, detail: 'conflict at 50141' },
      { onEpisode: () => {} },
    );
    expect(getOwnLogForkState(WS, HS).forked).toBe(true);

    const { d, calls } = deps({ getForkState: getOwnLogForkState, recover: undefined });
    const r = await runOwnLogForkRecovery(
      { workspaceId: WS, harnessSlug: HS, keyHex: KEY, confirm: true },
      d,
    );

    expect(r.outcome).toBe('recovered');
    if (r.outcome !== 'recovered') throw new Error('unreachable');
    expect(calls).toEqual(['close', `retire:${STORE}->${RETIRE_TO}`, 'reboot']);
    expect(r.forkStateAfter.forked).toBe(false);
  });
});
