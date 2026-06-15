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
