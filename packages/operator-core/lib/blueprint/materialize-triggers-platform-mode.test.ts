/**
 * Platform-mode deployment gate for the LAYER-3 platform-improvement loops
 * (per-hive-learning-loops-2026-06-14 P-070 / D-001).
 *
 * The `PLATFORM_IMPROVEMENT_LOOPS` knob gates the workspace-SINGLETON Class-C
 * frontier/measurement loops at MATERIALIZATION time: when platform mode is OFF (a
 * public release before the user opts in) a Class-C singleton trigger writes NO
 * `@singleton` routine row; when ON it materializes as today. gym/scout (per-hive
 * Class-B, layers 1-2) are NEVER gated — `scout` carries `singleton: true` but is
 * the per-hive exception. Registration-only gate — no loop logic changes.
 */
import type { Sql } from 'postgres';
import { describe, it, expect } from 'vitest';
import {
  materializeBlueprintTriggers,
  isPlatformImprovementLoop,
  platformImprovementLoopsEnabled,
  SINGLETON_TRIGGER_HOST_SLUG,
  type BlueprintTriggerInput,
} from './materialize-triggers';
import { FLAGS } from '@papercusp/flags';

/** A tagged-template `sql` stub: every call increments a counter and returns
 *  `[{ id }]` (the only shape the upsert path reads — `RETURNING id`). The gate
 *  skips a Class-C singleton BEFORE any sql call, so a 0 count proves it was gated. */
function makeSql(): { sql: Sql; getCalls: () => number } {
  let calls = 0;
  const fn = (() => {
    calls += 1;
    return Promise.resolve([{ id: 'rt_singleton_test' }]);
  }) as unknown as Sql;
  return { sql: fn, getCalls: () => calls };
}

const flagOn = async () => true;
const flagOff = async () => false;

/** A Class-C platform-improvement loop blueprint (a singleton trigger). */
const frontierBlueprint: BlueprintTriggerInput = {
  id: 'regret',
  triggers: { schedule: [{ cron: '0 35 */6 * * *', action: 'system:blueprint-run', singleton: true }] },
};

/** scout — singleton, but per-hive Class-B (must NOT be gated). */
const scoutBlueprint: BlueprintTriggerInput = {
  id: 'scout',
  triggers: {
    schedule: [{ cron: '0 */30 * * * *', action: 'system:blueprint-run', singleton: true, singletonActive: true }],
  },
};

/** A plain per-install (gym-style) blueprint — never gated, never a singleton. */
const perInstallBlueprint: BlueprintTriggerInput = {
  id: 'gym',
  triggers: { schedule: [{ cron: '0 0 9 * * *', action: 'system:blueprint-run' }] },
};

describe('isPlatformImprovementLoop (P-070 / D-001)', () => {
  it('every frontier/measurement singleton is a platform-improvement loop', () => {
    for (const id of [
      'graduation', 'negative-space', 'neologism', 'fleet-ekg', 'calibration',
      'deferral-interest', 'prompt-ablation', 'regret', 'transfer', 'red-queen',
      'change-ledger', 'iq-battery',
    ]) {
      expect(isPlatformImprovementLoop(id), id).toBe(true);
    }
  });

  it('scout is NOT a platform-improvement loop (per-hive Class-B exception)', () => {
    expect(isPlatformImprovementLoop('scout')).toBe(false);
  });

  it('an undefined blueprint id is never platform-improvement (defensive)', () => {
    expect(isPlatformImprovementLoop(undefined)).toBe(false);
  });
});

describe('platformImprovementLoopsEnabled (P-070)', () => {
  it('reflects the injected PLATFORM_IMPROVEMENT_LOOPS flag', async () => {
    expect(await platformImprovementLoopsEnabled({ flag: flagOn })).toBe(true);
    expect(await platformImprovementLoopsEnabled({ flag: flagOff })).toBe(false);
  });

  it('asks the flag bus for the PLATFORM_IMPROVEMENT_LOOPS key', async () => {
    let asked: string | undefined;
    await platformImprovementLoopsEnabled({
      flag: async (k) => {
        asked = k;
        return true;
      },
    });
    expect(asked).toBe(FLAGS.PLATFORM_IMPROVEMENT_LOOPS);
  });
});

describe('materializeBlueprintTriggers — platform-mode gate (P-070)', () => {
  it('REGISTERS a Class-C singleton when platform mode is ON', async () => {
    const { sql, getCalls } = makeSql();
    const rows = await materializeBlueprintTriggers('regret', frontierBlueprint, {
      sql,
      workspaceId: 'ws-test',
      flag: flagOn,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].hostSlug).toBe(SINGLETON_TRIGGER_HOST_SLUG);
    expect(rows[0].singleton).toBe(true);
    expect(getCalls()).toBe(1); // the upsert ran
  });

  it('SKIPS a Class-C singleton when platform mode is OFF (no @singleton row written)', async () => {
    const { sql, getCalls } = makeSql();
    const rows = await materializeBlueprintTriggers('regret', frontierBlueprint, {
      sql,
      workspaceId: 'ws-test',
      flag: flagOff,
    });
    expect(rows).toEqual([]); // dark — nothing materialized
    expect(getCalls()).toBe(0); // the upsert never ran (gated before any DB write)
  });

  it('NEVER gates scout — a per-hive Class-B singleton materializes even when platform mode is OFF', async () => {
    const { sql, getCalls } = makeSql();
    const rows = await materializeBlueprintTriggers('scout', scoutBlueprint, {
      sql,
      workspaceId: 'ws-test',
      flag: flagOff,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].singleton).toBe(true);
    expect(getCalls()).toBe(1); // scout still upserted despite platform mode off
  });

  it('NEVER gates a per-install (gym-style) trigger — and does not even read the flag', async () => {
    const { sql, getCalls } = makeSql();
    let flagRead = false;
    const rows = await materializeBlueprintTriggers('gym', perInstallBlueprint, {
      sql,
      workspaceId: 'ws-test',
      flag: async () => {
        flagRead = true;
        return false;
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].singleton).toBe(false);
    // The per-install upsert ran (NOT gated). NB: upsertRoutine builds its
    // flag-gated `ON CONFLICT` target as a nested `sql` fragment (F-E1), so a
    // single per-install upsert invokes the `sql` template more than once —
    // assert it RAN (a non-zero count proves the branch wasn't the gated skip),
    // not a brittle exact invocation count of upsertRoutine's internals.
    expect(getCalls()).toBeGreaterThanOrEqual(1); // per-install upsert ran
    expect(flagRead).toBe(false); // no gateable singleton ⇒ flag never consulted
  });
});
