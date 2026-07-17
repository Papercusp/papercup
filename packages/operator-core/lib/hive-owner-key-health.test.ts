import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  signalOwnedHiveKeyMissing,
  clearOwnedHiveKeyHealth,
  isOwnedHiveKeyMissingSignaled,
  _resetOwnerKeyHealthForTests,
  type OwnerKeyHealthDeps,
} from './hive-owner-key-health';

// Hoisted mocks for the DEFAULT-deps path (defaultEscalate) — used only by the
// "WI investigation 2026-07-17" describe block below, which exercises the
// real toast-write-with-retry logic instead of an injected fake `escalate`.
const insertValuesMock = vi.hoisted(() => vi.fn());
vi.mock('./agent-tools/coordination/messages', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    db: {
      insert: () => ({
        values: insertValuesMock,
      }),
    },
  }),
  generated: { toastLogInHarnessShared: {} },
}));

/**
 * Hermetic tests for the deduped owner-key-missing health signal
 * (shared-hive-member-content-federation-2026-06-20 D-024 / D-023 BUG A). The IO
 * (warn + escalate) is injected so no coord/PG is touched; the load-bearing
 * behavior is the per-(workspace,hive) dedup + the recovery-edge re-arm.
 */
describe('signalOwnedHiveKeyMissing', () => {
  beforeEach(() => _resetOwnerKeyHealthForTests());

  const fakeDeps = (): { deps: OwnerKeyHealthDeps; warned: string[]; escalated: string[] } => {
    const warned: string[] = [];
    const escalated: string[] = [];
    return {
      warned,
      escalated,
      deps: {
        warn: (m) => warned.push(m),
        escalate: async (ref) => {
          escalated.push(`${ref.workspaceId}::${ref.potSlug}`);
        },
        // Hermetic: no persistent toast_log read (default would touch PG).
        recentlyAlerted: async () => false,
      },
    };
  };

  it('first detection fires a LOUD warn + escalation and returns true', async () => {
    const { deps, warned, escalated } = fakeDeps();
    const fired = await signalOwnedHiveKeyMissing(
      { workspaceId: 'w', potSlug: 'h', context: 'cross-hive-boot' },
      deps,
    );
    expect(fired).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('owner key MISSING');
    expect(warned[0]).toContain('w/h');
    expect(warned[0]).toContain('cross-hive-boot');
    expect(escalated).toEqual(['w::h']);
    expect(isOwnedHiveKeyMissingSignaled({ workspaceId: 'w', potSlug: 'h' })).toBe(true);
  });

  it('DEDUP: re-detecting the same dark hive is suppressed (no second alert)', async () => {
    const { deps, warned, escalated } = fakeDeps();
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(false);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(false);
    expect(warned).toHaveLength(1); // only the first detection logged/escalated
    expect(escalated).toHaveLength(1);
  });

  it('dedup is PER (workspace, hive): a different hive still fires', async () => {
    const { deps, escalated } = fakeDeps();
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h1', context: 'c' }, deps);
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h2', context: 'c' }, deps);
    await signalOwnedHiveKeyMissing({ workspaceId: 'w2', potSlug: 'h1', context: 'c' }, deps);
    expect(escalated).toEqual(['w::h1', 'w::h2', 'w2::h1']);
  });

  it('RECOVERY: clearOwnedHiveKeyHealth re-arms so a later loss re-alerts', async () => {
    const { deps, escalated } = fakeDeps();
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(false);
    clearOwnedHiveKeyHealth({ workspaceId: 'w', potSlug: 'h' });
    expect(isOwnedHiveKeyMissingSignaled({ workspaceId: 'w', potSlug: 'h' })).toBe(false);
    // key went dark again → a NEW alert fires.
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(escalated).toEqual(['w::h', 'w::h']);
  });

  it('CROSS-RESTART: a hive alerted in a PRIOR process (in-mem set empty) is suppressed', async () => {
    // Simulates a fresh operator process (in-memory `signaled` reset by beforeEach)
    // where a persistent toast_log row from a prior boot already alerted this hive.
    const { warned, escalated } = fakeDeps();
    const persistedDeps: OwnerKeyHealthDeps = {
      warn: (m) => warned.push(m),
      escalate: async (ref) => escalated.push(`${ref.workspaceId}::${ref.potSlug}`),
      recentlyAlerted: async () => true, // a prior process already alerted within the window
    };
    const fired = await signalOwnedHiveKeyMissing(
      { workspaceId: 'w', potSlug: 'h', context: 'cross-hive-boot' },
      persistedDeps,
    );
    expect(fired).toBe(false); // suppressed by the persistent floor, not re-alerted on restart
    expect(warned).toHaveLength(0);
    expect(escalated).toHaveLength(0);
    // And it's cached in-process so a second detection this tick doesn't re-query.
    expect(isOwnedHiveKeyMissingSignaled({ workspaceId: 'w', potSlug: 'h' })).toBe(true);
  });

  it('CROSS-RESTART fail-open: a throwing recentlyAlerted still lets the alert fire', async () => {
    const { warned, escalated } = fakeDeps();
    const fired = await signalOwnedHiveKeyMissing(
      { workspaceId: 'w', potSlug: 'h', context: 'c' },
      {
        warn: (m) => warned.push(m),
        escalate: async (ref) => escalated.push(`${ref.workspaceId}::${ref.potSlug}`),
        recentlyAlerted: async () => {
          throw new Error('toast_log read blew up');
        },
      },
    );
    expect(fired).toBe(true); // fail-open: a persistent-check error never swallows a real alert
    expect(escalated).toEqual(['w::h']);
  });

  it('BEST-EFFORT: a throwing escalate (and warn) never throws into the caller', async () => {
    const throwingDeps: OwnerKeyHealthDeps = {
      warn: () => {
        throw new Error('logger blew up');
      },
      escalate: async () => {
        throw new Error('coord down');
      },
      recentlyAlerted: async () => false,
    };
    // Must resolve true (a fresh signal) without rejecting, despite both legs throwing.
    await expect(
      signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, throwingDeps),
    ).resolves.toBe(true);
  });

  it('marks the hive signaled even when the escalation throws (still deduped)', async () => {
    const escalate = vi.fn(async () => {
      throw new Error('boom');
    });
    const q = { warn: () => {}, escalate, recentlyAlerted: async () => false };
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, q);
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'c' }, q);
    expect(escalate).toHaveBeenCalledTimes(1); // second call deduped despite the first throwing
  });

  // WI investigation (2026-07-17): the coord broadcast carries no host field,
  // so a firing alert previously gave no way to tell which physical box /
  // process emitted it (proven live: neither the :3070 nor :3170 canonical
  // host actually runs cross-hive-boot, so a real firing is always some
  // THIRD process). The summary now stamps a per-machine fingerprint + PID.
  it('DIAGNOSABILITY: the summary carries a per-box identity tag (host fingerprint + pid)', async () => {
    const { deps } = fakeDeps();
    let capturedSummary = '';
    const q: OwnerKeyHealthDeps = {
      ...deps,
      escalate: async (_ref, summary) => {
        capturedSummary = summary;
      },
    };
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', potSlug: 'h', context: 'cross-hive-boot' }, q);
    // still carries the pre-existing, load-bearing substrings…
    expect(capturedSummary).toContain('w/h');
    expect(capturedSummary).toContain('cross-hive-boot');
    // …plus a diagnosable box identity: `#pid<N>`.
    expect(capturedSummary).toMatch(/#pid\d+/);
  });
});

// WI investigation (2026-07-17): defaultEscalate's toast_log write is the
// PERSISTENT cross-restart dedup floor (defaultRecentlyAlerted reads it
// back) — confirmed live that it silently failed on every real firing
// (2026-07-15..16) because cross-hive-boot calls it at the earliest phase of
// boot, before getOrgPg()'s admin client reliably resolves. These tests
// exercise the DEFAULT deps path (real defaultEscalate) with @papercusp/db-org
// mocked, to prove the retry recovers from exactly that transient failure
// instead of losing the dedup floor for the full 6h cooldown window.
describe('signalOwnedHiveKeyMissing — default escalate toast retry', () => {
  beforeEach(() => {
    _resetOwnerKeyHealthForTests();
    insertValuesMock.mockReset();
    vi.useFakeTimers();
  });

  it('RETRY: a transient toast-write failure (boot-time PG-not-ready) is retried and lands', async () => {
    insertValuesMock.mockRejectedValueOnce(new Error('PG not ready this early in boot'));
    insertValuesMock.mockResolvedValueOnce(undefined);

    const firedPromise = signalOwnedHiveKeyMissing(
      { workspaceId: 'w', potSlug: 'h', context: 'cross-hive-boot' },
      { warn: () => {}, recentlyAlerted: async () => false }, // isolate: exercise the real toast write, not the persistent-read leg
    );
    // Let the first (failing) insert attempt run, then fast-forward past the retry delay.
    await vi.advanceTimersByTimeAsync(6000);
    expect(await firedPromise).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
  });

  it('a second consecutive failure exhausts the single retry without throwing', async () => {
    insertValuesMock.mockRejectedValue(new Error('still not ready'));
    const firedPromise = signalOwnedHiveKeyMissing(
      { workspaceId: 'w', potSlug: 'h2', context: 'cross-hive-boot' },
      { warn: () => {}, recentlyAlerted: async () => false },
    );
    await vi.advanceTimersByTimeAsync(6000);
    await expect(firedPromise).resolves.toBe(true); // best-effort: never throws into the caller
    expect(insertValuesMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry, then gives up
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
