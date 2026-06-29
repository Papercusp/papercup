import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  signalOwnedHiveKeyMissing,
  clearOwnedHiveKeyHealth,
  isOwnedHiveKeyMissingSignaled,
  _resetOwnerKeyHealthForTests,
  type OwnerKeyHealthDeps,
} from './hive-owner-key-health';

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
          escalated.push(`${ref.workspaceId}::${ref.hiveSlug}`);
        },
      },
    };
  };

  it('first detection fires a LOUD warn + escalation and returns true', async () => {
    const { deps, warned, escalated } = fakeDeps();
    const fired = await signalOwnedHiveKeyMissing(
      { workspaceId: 'w', hiveSlug: 'h', context: 'cross-hive-boot' },
      deps,
    );
    expect(fired).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('owner key MISSING');
    expect(warned[0]).toContain('w/h');
    expect(warned[0]).toContain('cross-hive-boot');
    expect(escalated).toEqual(['w::h']);
    expect(isOwnedHiveKeyMissingSignaled({ workspaceId: 'w', hiveSlug: 'h' })).toBe(true);
  });

  it('DEDUP: re-detecting the same dark hive is suppressed (no second alert)', async () => {
    const { deps, warned, escalated } = fakeDeps();
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(false);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(false);
    expect(warned).toHaveLength(1); // only the first detection logged/escalated
    expect(escalated).toHaveLength(1);
  });

  it('dedup is PER (workspace, hive): a different hive still fires', async () => {
    const { deps, escalated } = fakeDeps();
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h1', context: 'c' }, deps);
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h2', context: 'c' }, deps);
    await signalOwnedHiveKeyMissing({ workspaceId: 'w2', hiveSlug: 'h1', context: 'c' }, deps);
    expect(escalated).toEqual(['w::h1', 'w::h2', 'w2::h1']);
  });

  it('RECOVERY: clearOwnedHiveKeyHealth re-arms so a later loss re-alerts', async () => {
    const { deps, escalated } = fakeDeps();
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(false);
    clearOwnedHiveKeyHealth({ workspaceId: 'w', hiveSlug: 'h' });
    expect(isOwnedHiveKeyMissingSignaled({ workspaceId: 'w', hiveSlug: 'h' })).toBe(false);
    // key went dark again → a NEW alert fires.
    expect(await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, deps)).toBe(true);
    expect(escalated).toEqual(['w::h', 'w::h']);
  });

  it('BEST-EFFORT: a throwing escalate (and warn) never throws into the caller', async () => {
    const throwingDeps: OwnerKeyHealthDeps = {
      warn: () => {
        throw new Error('logger blew up');
      },
      escalate: async () => {
        throw new Error('coord down');
      },
    };
    // Must resolve true (a fresh signal) without rejecting, despite both legs throwing.
    await expect(
      signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, throwingDeps),
    ).resolves.toBe(true);
  });

  it('marks the hive signaled even when the escalation throws (still deduped)', async () => {
    const escalate = vi.fn(async () => {
      throw new Error('boom');
    });
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, { warn: () => {}, escalate });
    await signalOwnedHiveKeyMissing({ workspaceId: 'w', hiveSlug: 'h', context: 'c' }, { warn: () => {}, escalate });
    expect(escalate).toHaveBeenCalledTimes(1); // second call deduped despite the first throwing
  });
});
