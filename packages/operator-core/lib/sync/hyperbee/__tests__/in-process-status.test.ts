/**
 * getInProcessSubstrateStatus tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getInProcessSubstrateStatus, resolveEffectiveBootedHandles } from '../in-process-status';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../boot-all';
import {
  _resetTrackerForTests as _resetBootstrapForTests,
  recordMergedOps,
} from '../bootstrap-progress';
import type { BootedHarnessHandle } from '../boot';
import { makeFakeBootedHandle } from './fake-booted-handle';

afterEach(() => {
  _resetHandleMapForTests();
  _resetBootstrapForTests();
});

// Regression guard (found live 2026-07-19 while verifying EI-2634): every plain
// `getInProcessSubstrateStatus()` call in this file (i.e. every call OUTSIDE the
// dedicated "request-only secondary default" describe below, which deliberately
// sets this) implicitly relies on `isSubstrateOwnerProcess`'s default —
// `requestOnlyHost()` reading AMBIENT `process.env.PAPERCUSP_BACKGROUND_WORKERS` /
// `PAPERCUSP_HONO_PORT` (background-workers.ts) — resolving to "this IS the
// substrate owner". `libs/test-config/src/setup-hermetic-env.ts` (every vitest file's
// first setupFile) now scrubs both vars before any test file loads, so this file no
// longer needs its own save/scrub/restore — see that file for the full history
// (EI-2634: 16/32 tests here + the sibling integration-smoke.test.ts failed
// deterministically in any su/psu shell before the central scrub landed).

function fakeHandle(
  workspaceId: string,
  harnessSlug: string,
): BootedHarnessHandle {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
}

describe('getInProcessSubstrateStatus', () => {
  it('forceDisabledForTest + no handles → disabled summary, 0 harnesses', () => {
    const r = getInProcessSubstrateStatus({ forceDisabledForTest: true });
    expect(r.substrateActive).toBe(false);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('disabled');
  });

  it('active (default) + no handles → healthy summary (idle — nothing shared)', () => {
    const r = getInProcessSubstrateStatus();
    expect(r.substrateActive).toBe(true);
    expect(r.bootedCount).toBe(0);
    expect(r.harnesses).toEqual([]);
    expect(r.summary.worstVerdict).toBe('healthy');
  });

  it('active + one healthy handle', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus();
    expect(r.bootedCount).toBe(1);
    expect(r.harnesses).toHaveLength(1);
    expect(r.harnesses[0]?.verdict).toBe('healthy');
    expect(r.summary.worstVerdict).toBe('healthy');
    expect(r.summary.totalHarnesses).toBe(1);
  });

  it('resolveClaimStats threads through to verdict', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    const r = getInProcessSubstrateStatus({
      resolveClaimStats: () => ({
        total: 100,
        won: 70,
        lost: 0,
        error: 30,
      }),
    });
    expect(r.harnesses[0]?.verdict).toBe('unhealthy');
    expect(r.summary.worstVerdict).toBe('unhealthy');
  });

  it('worst-wins across multiple harnesses', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
    _setHandleForTests('ws-1', 'c', fakeHandle('ws-1', 'c'));
    const r = getInProcessSubstrateStatus({
      resolveClaimStats: (_w, slug) =>
        slug === 'b'
          ? { total: 100, won: 60, lost: 0, error: 40 }
          : { total: 0, won: 0, lost: 0, error: 0 },
    });
    expect(r.summary.worstVerdict).toBe('unhealthy');
    const bRow = r.harnesses.find((h) => h.harnessSlug === 'b');
    expect(bRow?.verdict).toBe('unhealthy');
  });

  it('bootstrap-progress feeds into verdict', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    // Record progress that hasn't moved in over the stall threshold —
    // assessHarnessSubstrateHealth flips to unhealthy when mergedOps
    // lags highestSeen past staleThresholdMs (default 5 min). For
    // this test we record a snapshot with mergedOps < highestSeen and
    // rely on the default time-now to be > snapshot.lastChangeMs +
    // 5min, which won't be the case here. Instead just confirm the
    // progress data threads through and renders as healthy when fresh.
    recordMergedOps('ws-1', 'a', 5);
    const r = getInProcessSubstrateStatus();
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('default resolveClaimStats yields zero stats', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    const r = getInProcessSubstrateStatus();
    // No claim stats provided + handle present → healthy by default.
    expect(r.harnesses[0]?.verdict).toBe('healthy');
  });

  it('forceDisabledForTest forces the disabled rendering (test seam only)', () => {
    const r = getInProcessSubstrateStatus({ forceDisabledForTest: true });
    expect(r.substrateActive).toBe(false);
  });

  it('substrate is active by default (always boots, Stage 4d — no flag gate)', () => {
    const r = getInProcessSubstrateStatus();
    expect(r.substrateActive).toBe(true);
  });

  // WI-899 (A): resolveSidecarLive is the seam that lets a dead SUBSTRATE_SIDECAR
  // override the boot-time handle proxy (which stays "present" even after the
  // sidecar process that owns replication has died).
  describe('resolveSidecarLive (WI-899 A)', () => {
    it('resolveSidecarLive() => false forces every booted harness unhealthy', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => false,
      });
      expect(r.harnesses.every((h) => h.verdict === 'unhealthy')).toBe(true);
      expect(r.summary.worstVerdict).toBe('unhealthy');
    });

    it('resolveSidecarLive() => true does not itself force a healthy verdict', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => true,
        resolveClaimStats: () => ({ total: 100, won: 0, lost: 0, error: 100 }),
      });
      expect(r.harnesses[0]?.verdict).toBe('unhealthy');
    });

    it('resolveSidecarLive() => null is a no-op (sidecar mode off)', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => null,
      });
      expect(r.harnesses[0]?.verdict).toBe('healthy');
    });

    it('default (no resolveSidecarLive passed) resolves null and has no effect', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus();
      expect(r.harnesses[0]?.verdict).toBe('healthy');
    });

    it('resolveSidecarLive is resolved ONCE per call, not per-harness', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      _setHandleForTests('ws-1', 'b', fakeHandle('ws-1', 'b'));
      _setHandleForTests('ws-1', 'c', fakeHandle('ws-1', 'c'));
      let calls = 0;
      const r = getInProcessSubstrateStatus({
        resolveSidecarLive: () => {
          calls += 1;
          return null;
        },
      });
      expect(r.harnesses).toHaveLength(3);
      expect(calls).toBe(1);
    });
  });

  // EI-8816: the cluster-worker blind spot. listBootedHandles() is process-local, so a
  // request-only true-cluster worker's own local map is ALWAYS empty (the substrate boots
  // only on the primary) — resolveEffectiveBootedHandles + the isSubstrateOwnerProcess(ForTest)
  // seam decide whether to trust local directly, fall back to a cached remote broadcast, or
  // report an explicit reachedSubstrateOwner:false blind spot (never silently identical to a
  // genuinely-empty substrate).
  describe('resolveEffectiveBootedHandles (EI-8816, pure unit)', () => {
    const H1 = [{ workspaceId: 'ws-1', harnessSlug: 'a' }];

    it('substrate-owner process (primary / single-process): trusts local directly, even when empty', () => {
      expect(resolveEffectiveBootedHandles(H1, { isSubstrateOwnerProcess: true })).toEqual({
        booted: H1,
        reachedSubstrateOwner: true,
      });
      expect(resolveEffectiveBootedHandles([], { isSubstrateOwnerProcess: true })).toEqual({
        booted: [],
        reachedSubstrateOwner: true, // legitimately idle — NOT a blind spot
      });
    });

    it('non-owner (worker) with a FRESH cached remote snapshot: uses the remote handles', () => {
      const r = resolveEffectiveBootedHandles([], {
        isSubstrateOwnerProcess: false,
        resolveRemote: () => ({ handles: H1, receivedAt: 1_000 }),
        now: 1_000 + 10_000, // 10s old, under the 15s default max age
      });
      expect(r).toEqual({ booted: H1, reachedSubstrateOwner: true });
    });

    it('non-owner (worker) with a STALE cached remote snapshot: blind spot, not silently trusted', () => {
      const r = resolveEffectiveBootedHandles([], {
        isSubstrateOwnerProcess: false,
        resolveRemote: () => ({ handles: H1, receivedAt: 1_000 }),
        now: 1_000 + 20_000, // past the 15s default max age
      });
      expect(r).toEqual({ booted: [], reachedSubstrateOwner: false });
    });

    it('non-owner (worker) with NO cached remote snapshot yet: blind spot', () => {
      const r = resolveEffectiveBootedHandles([], {
        isSubstrateOwnerProcess: false,
        resolveRemote: () => null,
      });
      expect(r).toEqual({ booted: [], reachedSubstrateOwner: false });
    });

    it('non-owner (worker) with no resolveRemote wired at all: blind spot (never throws)', () => {
      const r = resolveEffectiveBootedHandles([], { isSubstrateOwnerProcess: false });
      expect(r).toEqual({ booted: [], reachedSubstrateOwner: false });
    });

    it('respects a custom maxAgeMs', () => {
      const r = resolveEffectiveBootedHandles([], {
        isSubstrateOwnerProcess: false,
        resolveRemote: () => ({ handles: H1, receivedAt: 1_000 }),
        now: 1_000 + 4_000,
        maxAgeMs: 3_000,
      });
      expect(r.reachedSubstrateOwner).toBe(false);
    });
  });

  describe('reachedSubstrateOwner wired through getInProcessSubstrateStatus (EI-8816)', () => {
    it('defaults isSubstrateOwnerProcess from the real process (this test process is never a forked worker) — always true here', () => {
      const r = getInProcessSubstrateStatus();
      expect(r.reachedSubstrateOwner).toBe(true);
    });

    it('isSubstrateOwnerProcessForTest:false + no remote resolver ⇒ reachedSubstrateOwner:false, bootedCount:0 even with local handles set', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      const r = getInProcessSubstrateStatus({ isSubstrateOwnerProcessForTest: false });
      expect(r.reachedSubstrateOwner).toBe(false);
      expect(r.bootedCount).toBe(0);
      expect(r.harnesses).toEqual([]);
    });

    it('isSubstrateOwnerProcessForTest:false + a fresh resolveRemoteBootedHandles ⇒ uses the remote handles', () => {
      const r = getInProcessSubstrateStatus({
        isSubstrateOwnerProcessForTest: false,
        resolveRemoteBootedHandles: () => ({
          handles: [{ workspaceId: 'ws-1', harnessSlug: 'remote-a' }],
          receivedAt: Date.now(),
        }),
      });
      expect(r.reachedSubstrateOwner).toBe(true);
      expect(r.bootedCount).toBe(1);
      expect(r.harnesses[0]).toMatchObject({ workspaceId: 'ws-1', harnessSlug: 'remote-a' });
    });

    // EI-20575137548097507 — THE RECURRENCE GUARD.
    //
    // The test directly above is the exact shape of the live defect: it asserts
    // the remote handles are adopted and `reachedSubstrateOwner:true`, and never
    // looks at the verdict. On this box that path reported "97/97 healthy, no
    // issues detected" while the replication-liveness detector was concurrently
    // filing a MAJOR connected_never_replicated stall for one of those very
    // harnesses (EI-20562138012694244).
    //
    // The cause is structural, not a missing branch: `booted` comes from the
    // REMOTE snapshot while replication-liveness / own-log-fork / log-stats are
    // module-scope state in the substrate OWNER process. On a non-owner the
    // per-harness join therefore misses BY CONSTRUCTION, every health input
    // arrives as `undefined`, and "not measured" rendered as "nothing wrong".
    //
    // This has now recurred five times (EI-18735338283879820,
    // EI-19328421457282435, EI-19327550671915579, WI-5307, and this one) because
    // each fix widened the BOOTED-HANDLE leg (local map → cluster IPC → PG
    // fallback) and left the health-input legs process-local — so the surface
    // kept reporting MORE harnesses it was NO better able to assess. Assert the
    // invariant itself, so instance six fails here instead of in production.
    it('a non-owner process must NEVER report healthy for a harness it could not measure', () => {
      const r = getInProcessSubstrateStatus({
        isSubstrateOwnerProcessForTest: false,
        resolveRemoteBootedHandles: () => ({
          handles: [{ workspaceId: 'ws-1', harnessSlug: 'remote-a' }],
          receivedAt: Date.now(),
        }),
      });

      // It still reports the harnesses (that leg is genuinely fixed) ...
      expect(r.bootedCount).toBe(1);
      // ... but must not claim to have assessed them.
      expect(r.healthInputsObserved).toBe(false);
      expect(r.harnesses[0]!.verdict).not.toBe('healthy');
      expect(r.harnesses[0]!.reasons).not.toContain('no issues detected');
      expect(r.harnesses[0]!.reasons.join(' ')).toMatch(/UNOBSERVABLE from this process/);
      expect(r.summary.worstVerdict).not.toBe('healthy');

      // `reachedSubstrateOwner` must NOT be reused as the observability marker:
      // it is true on BOTH the owner path and this cached path, which is exactly
      // why it could never have caught this. The two must stay distinguishable.
      expect(r.reachedSubstrateOwner).toBe(true);
      expect(r.healthInputsObserved).not.toBe(r.reachedSubstrateOwner);
    });

    it('the substrate OWNER still reports healthy — the guard must not blanket-degrade', () => {
      _setHandleForTests('ws-1', 'owned-a', fakeHandle('ws-1', 'owned-a'));
      const r = getInProcessSubstrateStatus({ isSubstrateOwnerProcessForTest: true });
      expect(r.healthInputsObserved).toBe(true);
      expect(r.harnesses[0]!.verdict).toBe('healthy');
      expect(r.harnesses[0]!.reasons).toContain('no issues detected');
    });
  });

  // WI-5307: a request-only secondary host (dedicated-bg-host topology's :3070/:3270)
  // is a node:cluster PRIMARY (never a forked worker) that has DECLARED itself
  // request-only, so it never boots the substrate — the DEFAULT isSubstrateOwnerProcess
  // computation (no isSubstrateOwnerProcessForTest override) must exclude it, not just
  // trust `nodeCluster.isPrimary`. Exercised via the real env-derived `requestOnlyHost()`
  // (background-workers.ts) — no isSubstrateOwnerProcessForTest override, so this is the
  // production default path.
  describe('request-only secondary default (WI-5307)', () => {
    const ENV_KEYS = ['PAPERCUSP_BACKGROUND_WORKERS', 'PAPERCUSP_HONO_PORT'] as const;
    let saved: Record<string, string | undefined>;

    function setRequestOnly(): void {
      saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
      process.env.PAPERCUSP_BACKGROUND_WORKERS = '0';
    }
    function restoreEnv(): void {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }

    afterEach(() => {
      restoreEnv();
    });

    it('PAPERCUSP_BACKGROUND_WORKERS=0 (request-only) + a local handle set + no default override ⇒ reachedSubstrateOwner:false, NOT a false-confident empty', () => {
      _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
      setRequestOnly();
      const r = getInProcessSubstrateStatus();
      expect(r.reachedSubstrateOwner).toBe(false);
      expect(r.bootedCount).toBe(0);
      expect(r.harnesses).toEqual([]);
    });

    it('PAPERCUSP_BACKGROUND_WORKERS=0 (request-only) + a fresh resolveRemoteBootedHandles ⇒ uses the remote handles', () => {
      setRequestOnly();
      const r = getInProcessSubstrateStatus({
        resolveRemoteBootedHandles: () => ({
          handles: [{ workspaceId: 'ws-1', harnessSlug: 'remote-a' }],
          receivedAt: Date.now(),
        }),
      });
      expect(r.reachedSubstrateOwner).toBe(true);
      expect(r.bootedCount).toBe(1);
    });
  });
});
