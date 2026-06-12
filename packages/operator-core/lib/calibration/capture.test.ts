/**
 * The capture seam's contract (P-041 / FB-13): flag-gated, never throws into
 * a host call path, never touches the pool before the flag check passes
 * (hermetic — no PG, no flags IO; everything injected).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { recordPrediction, type CalibrationCaptureDeps } from './capture';
import type { InsertPredictionInput } from './store';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function deps(over: Partial<CalibrationCaptureDeps> = {}): {
  deps: CalibrationCaptureDeps;
  inserted: InsertPredictionInput[];
  getSql: ReturnType<typeof vi.fn>;
} {
  const inserted: InsertPredictionInput[] = [];
  const getSql = vi.fn(async () => ({}) as Sql);
  return {
    inserted,
    getSql,
    deps: {
      isEnabled: async () => true,
      getSql,
      insert: async (_sql, q) => {
        inserted.push(q);
        return { created: true, id: '1' };
      },
      workspaceId: async () => 'ws-test',
      nowMs: () => NOW,
      log: () => {},
      ...over,
    },
  };
}

const BASE = {
  predictor: 'su-abc12',
  domain: 'fix-survival' as const,
  subjectKind: 'improvement' as const,
  subjectId: 'EI-1',
  claim: 'fix survives 14d',
};

describe('recordPrediction', () => {
  it('flag OFF → not recorded, and the pool is never touched', async () => {
    const d = deps({ isEnabled: async () => false });
    const out = await recordPrediction(BASE, d.deps);
    expect(out).toEqual({ recorded: false, reason: 'flag-off' });
    expect(d.getSql).not.toHaveBeenCalled();
  });

  it('records the implicit domain prior as stated:false with the domain horizon', async () => {
    const d = deps();
    const out = await recordPrediction(BASE, d.deps);
    expect(out).toEqual({ recorded: true });
    expect(d.inserted).toHaveLength(1);
    expect(d.inserted[0]).toMatchObject({
      workspaceId: 'ws-test',
      predictor: 'su-abc12',
      domain: 'fix-survival',
      probability: 0.8,
      stated: false,
      origin: 'organic',
    });
    expect(d.inserted[0].horizonTs).toBe(new Date(NOW + 14 * DAY_MS).toISOString());
  });

  it('an explicit probability is a stated bet', async () => {
    const d = deps();
    await recordPrediction({ ...BASE, probability: 0.35 }, d.deps);
    expect(d.inserted[0]).toMatchObject({ probability: 0.35, stated: true });
  });

  it('refuses an out-of-range probability without inserting', async () => {
    const d = deps();
    const out = await recordPrediction({ ...BASE, probability: 1.2 }, d.deps);
    expect(out).toEqual({ recorded: false, reason: 'invalid-probability' });
    expect(d.inserted).toHaveLength(0);
  });

  it('a second open bet on the same lane reads duplicate, not error', async () => {
    const d = deps({ insert: async () => ({ created: false, id: null }) });
    const out = await recordPrediction(BASE, d.deps);
    expect(out).toEqual({ recorded: false, reason: 'duplicate-open-bet' });
  });

  it('NEVER throws into the host — an insert failure returns error', async () => {
    const d = deps({
      insert: async () => {
        throw new Error('pg down');
      },
    });
    const out = await recordPrediction(BASE, d.deps);
    expect(out).toEqual({ recorded: false, reason: 'error' });
  });

  it('threads origin + watchdogKey + horizon override through', async () => {
    const d = deps();
    await recordPrediction(
      {
        ...BASE,
        domain: 'flake-recurrence',
        origin: 'drill',
        watchdogKey: 'redtest:foo.test.ts',
        horizonDays: 7,
      },
      d.deps,
    );
    expect(d.inserted[0]).toMatchObject({
      origin: 'drill',
      watchdogKey: 'redtest:foo.test.ts',
      probability: 0.6,
    });
    expect(d.inserted[0].horizonTs).toBe(new Date(NOW + 7 * DAY_MS).toISOString());
  });
});
