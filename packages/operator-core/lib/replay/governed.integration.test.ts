/** Real replay cells and governor reservations on a private, migrated PG. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { registerReplayLoop, runGovernedReplay } from './governed';
import { REPLAY_BASELINE_VARIANT } from './battery';
import { REPLAY_LOOP_ID, type ReplayRunner } from './types';
import { getLearningLoop, listLearningSpendEvents, listLearningSpendReservations } from '../learning-governor/store';
import { LEARNING_GOVERNOR_BUDGET_FLOOR_USD } from '../learning-governor/core';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 240_000);
afterAll(async () => { await db?.cleanup(); });

const config = (batteryId: string) => ({ batteryId, variants: [REPLAY_BASELINE_VARIANT],
  cases: [{ kind: 'synthetic' as const, caseId: 'task', context: 'existing task', intent: 'complete the task' }], repeats: 1 });
const judge = async () => ({ text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'fixture verdict' }),
  costUsd: 0.01, inputTokens: 1, outputTokens: 1 });
const run: ReplayRunner = async () => ({ outputText: 'completed task', costUsd: 0.05,
  inputTokens: 1, outputTokens: 1, replayed: true });
const glue = () => ({ enabled: async () => true, getSql: async () => db.adminSql,
  preflight: async () => ({ allow: true, remainingUsd: 1 }), log: (message: string) => { throw new Error(message); } });

describe('governed replay durable spend boundary', () => {
  it('records a reservation before actual replay execution and charges the battery once', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const batteryId = 'replay-reserve-first';
    const runner: ReplayRunner = async (input) => {
      const rows = await listLearningSpendReservations(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', attemptKind: 'evaluation', runRef: batteryId, usedUsd: 0 });
      expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
      return run(input);
    };
    const out = await runGovernedReplay({ workspaceId, config: config(batteryId) },
      { runner, llmCall: judge, now: () => Date.now() }, glue());
    expect(out.result?.outcomes[0].status).toBe('scored');
    expect(out.reservation).toMatchObject({ status: 'settled', usedUsd: 0.06, signalOrigin: 'replay' });
    expect(out.reservation?.settledAt).toEqual(expect.any(Number));
    const events = await listLearningSpendEvents(db.adminSql, { workspaceId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runRef: batteryId, reservationId: out.reservation!.id, costUsd: 0.06 });
    expect((await getLearningLoop(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID }))?.spentUsd).toBeCloseTo(0.06);
    const cells = await db.adminSql`SELECT status FROM harness_shared.replay_runs WHERE workspace_id = ${workspaceId}`;
    expect(cells).toEqual([{ status: 'scored' }]);
  });

  it('two overlapping batteries reserve within shared headroom despite identical preflight snapshots', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    let started = 0;
    let bothStarted!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: ReplayRunner = async (input) => {
      if (++started === 2) bothStarted();
      await gate;
      return run(input);
    };
    const pending = Promise.all(['a', 'b'].map((batteryId) => runGovernedReplay(
      { workspaceId, config: { ...config(batteryId), maxSpendUsd: 0.8 } },
      { runner, llmCall: judge, now: () => Date.now() }, glue(),
    )));
    try {
      await ready;
      const rows = await listLearningSpendReservations(db.adminSql, { workspaceId, status: 'open' });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.runRef).sort()).toEqual(['a', 'b']);
      const reservedUsd = rows.reduce((sum, row) => sum + row.reservedUsd, 0);
      expect(reservedUsd).toBeCloseTo(1 - LEARNING_GOVERNOR_BUDGET_FLOOR_USD);
      expect(rows.some((row) => row.reservedUsd < row.requestedUsd)).toBe(true);
      expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
    } finally { release(); }
    const results = await pending;
    expect(results.every((result) => result.reservation?.status === 'settled')).toBe(true);
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(2);
    expect((await getLearningLoop(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID }))?.spentUsd).toBeCloseTo(0.12);
  });

  it('a genuinely free battery still leaves a settled evaluation reservation and no charge event', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const out = await runGovernedReplay({ workspaceId, config: config('free') }, {
      runner: async (input) => ({ ...await run(input), costUsd: 0 }),
      llmCall: async () => ({ ...await judge(), costUsd: 0 }), now: () => Date.now(),
    }, glue());
    expect(out.result?.outcomes[0].status).toBe('scored');
    expect(out.reservation).toMatchObject({ status: 'settled', usedUsd: 0 });
    expect(await listLearningSpendReservations(db.adminSql, { workspaceId })).toHaveLength(1);
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
  });
});
