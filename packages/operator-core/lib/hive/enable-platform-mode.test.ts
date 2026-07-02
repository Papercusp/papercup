import { describe, it, expect } from 'vitest';
import { enablePlatformMode, type EnablePlatformModeInput } from './enable-platform-mode';

// All external effects (flag store / repo clone / PG singleton materialization) are
// injectable seams, so the whole enable flow is unit-testable with no real IO.
function deps(over: Partial<EnablePlatformModeInput> = {}): EnablePlatformModeInput {
  return {
    workspaceId: 'w',
    sql: {} as never,
    setFlag: async () => ({ ok: true as const }),
    createSelfHive: async () =>
      ({ ok: true, created: { hiveSlug: 'papercusp-platform-hive', memberSlug: 'papercusp-platform' } }) as never,
    // WI-1293: default the self-hive to NOT-yet-locally-registered so the
    // existing tests below still exercise `createSelfHive` exactly as before —
    // without this seam every test would hit the REAL `loadHarnessRegistry`
    // (real PG/file IO), breaking the file's no-real-IO unit-test invariant.
    checkSelfHiveRegistered: async () => false,
    armSingletons: async () =>
      [
        { declaresSingleton: true, skipped: false, plannedNames: ['bp-singleton-graduation-0'] },
        { declaresSingleton: true, skipped: false, plannedNames: ['bp-singleton-calibration-0'] },
      ] as never,
    ...over,
  };
}

describe('enablePlatformMode (per-hive-learning-loops P-071)', () => {
  it('happy path: flips the flag, stands up the self-hive, arms the layer-3 loops', async () => {
    const res = await enablePlatformMode(deps());
    expect(res.ok).toBe(true);
    expect(res.flagEnabled.ok).toBe(true);
    expect(res.selfHive).toMatchObject({ ok: true, status: 'created', hiveSlug: 'papercusp-platform-hive' });
    expect(res.armedLoops).toMatchObject({ ok: true, materialized: 2 });
    expect(res.summary).toContain('ENABLED');
  });

  it('ORDER: the flag flips BEFORE the singletons are armed (so materialization sees it ON)', async () => {
    const calls: string[] = [];
    await enablePlatformMode(
      deps({
        setFlag: async () => {
          calls.push('flag');
          return { ok: true as const };
        },
        armSingletons: async () => {
          calls.push('arm');
          return [] as never;
        },
      }),
    );
    expect(calls).toEqual(['flag', 'arm']);
  });

  it('an already-standing self-hive is a success path (re-enable never double-creates)', async () => {
    const res = await enablePlatformMode(
      deps({ createSelfHive: async () => ({ ok: true, existing: { kind: 'join-offer' } }) as never }),
    );
    expect(res.ok).toBe(true);
    expect(res.selfHive).toMatchObject({ ok: true, status: 'already_standing' });
  });

  it('a partial enable is REPORTED, never thrown (self-hive stand-up fails)', async () => {
    const res = await enablePlatformMode(
      deps({ createSelfHive: async () => ({ ok: false, error: 'clone-failed' }) as never }),
    );
    expect(res.ok).toBe(false);
    expect(res.selfHive).toMatchObject({ ok: false, status: 'failed', error: 'clone-failed' });
    expect(res.summary).toContain('PARTIALLY');
  });

  // WI-1293: platform:enable's legacy_shared_harness enable path never stood up
  // the dedicated self-hive, so a later platform:contribute failed with
  // self_hive_not_found. Fixed by guarding on the ACTUAL local registration of
  // `<slug>-hive` (unambiguous, slug-scoped) instead of trusting
  // `createHiveFromRepo`'s generic repo-identity lookup (which matches ANY
  // harness tracking the same repo, e.g. this dev box's own live checkout).
  it('WI-1293: an already-LOCALLY-REGISTERED self-hive short-circuits WITHOUT re-calling createSelfHive', async () => {
    let called = false;
    const res = await enablePlatformMode(
      deps({
        checkSelfHiveRegistered: async () => true,
        createSelfHive: async () => {
          called = true;
          throw new Error('must not be called — the self-hive is already registered');
        },
      }),
    );
    expect(called).toBe(false);
    expect(res.selfHive).toMatchObject({ ok: true, status: 'already_standing', detail: 'platform_self_hive' });
    expect(res.ok).toBe(true);
  });

  it('WI-1293: NOT yet locally registered -> createSelfHive is called with force:true (bypasses a same-repo different-slug legacy binding)', async () => {
    let passedForce: unknown;
    await enablePlatformMode(
      deps({
        checkSelfHiveRegistered: async () => false,
        createSelfHive: async (opts) => {
          passedForce = (opts as { force?: boolean }).force;
          return { ok: true, created: { hiveSlug: 'papercusp-platform-hive', memberSlug: 'papercusp-platform' } } as never;
        },
      }),
    );
    expect(passedForce).toBe(true);
  });

  it('WI-1293: checkSelfHiveRegistered is queried for the actual `<slug>-hive` (custom slug respected)', async () => {
    const seen: string[] = [];
    await enablePlatformMode(
      deps({
        slug: 'my-platform',
        checkSelfHiveRegistered: async (hiveSlug) => {
          seen.push(hiveSlug);
          return false;
        },
      }),
    );
    expect(seen).toEqual(['my-platform-hive']);
  });

  it('a throwing seam never crashes the flow — best-effort, the prior steps still hold', async () => {
    const res = await enablePlatformMode(
      deps({
        armSingletons: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(res.armedLoops).toMatchObject({ ok: false });
    expect(res.ok).toBe(false);
    expect(res.flagEnabled.ok).toBe(true);
    expect(res.selfHive.ok).toBe(true);
  });
});
