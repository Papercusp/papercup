/**
 * Sweep semantics (P-041 / FB-13), PG-free: probes answer → resolve;
 * undeterminable inside grace → left open; past grace → voided (never
 * scored); a throwing probe never kills the tick.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { runCalibrationResolveTick, VOID_GRACE_DAYS, type OutcomeProbes } from './resolve-sweep';
import type { PredictionRow } from './types';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function bet(over: Partial<PredictionRow>): PredictionRow {
  return {
    id: 'b1',
    workspaceId: 'ws',
    predictor: 'su-a',
    domain: 'fix-survival',
    subjectKind: 'improvement',
    subjectId: 'EI-1',
    claim: 'c',
    probability: 0.8,
    stated: false,
    origin: 'organic',
    watchdogKey: null,
    horizonTs: NOW - DAY_MS,
    createdAt: NOW - 15 * DAY_MS,
    resolvedAt: null,
    outcome: null,
    resolutionNote: null,
    ...over,
  };
}

const probes = (over: Partial<OutcomeProbes> = {}): OutcomeProbes => ({
  fixSurvived: async () => true,
  planShipped: async () => false,
  flakeRecurred: async () => null,
  ...over,
});

function run(bets: PredictionRow[], p: OutcomeProbes) {
  const resolved: Array<{ id: string; outcome: boolean }> = [];
  const voided: string[] = [];
  return {
    resolved,
    voided,
    tick: () =>
      runCalibrationResolveTick(
        'ws',
        {
          sql: {} as Sql,
          probes: p,
          list: async () => bets,
          resolve: async (_sql, q) => {
            resolved.push({ id: q.id, outcome: q.outcome });
            return true;
          },
          voidBet: async (_sql, q) => {
            voided.push(q.id);
            return true;
          },
          nowMs: () => NOW,
          log: () => {},
        },
        { limit: 50 },
      ),
  };
}

describe('runCalibrationResolveTick', () => {
  it('routes each domain to its probe and records the outcome', async () => {
    const r = run(
      [
        bet({ id: 'fix', domain: 'fix-survival' }),
        bet({ id: 'plan', domain: 'plan-ship', subjectKind: 'plan', subjectId: 'some-plan' }),
      ],
      probes(),
    );
    const out = await r.tick();
    expect(out).toMatchObject({ matured: 2, resolved: 2, voided: 0, skipped: 0 });
    expect(r.resolved).toEqual([
      { id: 'fix', outcome: true },
      { id: 'plan', outcome: false },
    ]);
  });

  it('leaves an undeterminable bet open inside grace', async () => {
    const r = run([bet({ id: 'fl', domain: 'flake-recurrence' })], probes());
    const out = await r.tick();
    expect(out).toMatchObject({ resolved: 0, voided: 0, skipped: 1 });
  });

  it('voids an undeterminable bet past grace — it never enters scoring', async () => {
    const stale = bet({
      id: 'fl',
      domain: 'flake-recurrence',
      horizonTs: NOW - (VOID_GRACE_DAYS + 1) * DAY_MS,
    });
    const r = run([stale], probes());
    const out = await r.tick();
    expect(out).toMatchObject({ resolved: 0, voided: 1, skipped: 0 });
    expect(r.voided).toEqual(['fl']);
  });

  it('treats an unknown domain like undeterminable (open in grace, voided past it)', async () => {
    const r = run(
      [
        bet({ id: 'new', domain: 'future-domain' }),
        bet({ id: 'old', domain: 'future-domain', horizonTs: NOW - (VOID_GRACE_DAYS + 1) * DAY_MS }),
      ],
      probes(),
    );
    const out = await r.tick();
    expect(out).toMatchObject({ skipped: 1, voided: 1 });
  });

  it('a throwing probe skips that bet, the tick continues', async () => {
    const r = run(
      [bet({ id: 'boom' }), bet({ id: 'ok', domain: 'plan-ship' })],
      probes({
        fixSurvived: async () => {
          throw new Error('probe down');
        },
      }),
    );
    const out = await r.tick();
    expect(out).toMatchObject({ matured: 2, resolved: 1, skipped: 1 });
    expect(r.resolved).toEqual([{ id: 'ok', outcome: false }]);
  });
});
