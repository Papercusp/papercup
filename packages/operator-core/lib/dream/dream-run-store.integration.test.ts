/**
 * Migration 862 + dream-run/store/spend integration against real migrated PG.
 * Resolves the real migration in either parked or armed form so the same test
 * protects authoring, arming, and post-apply states.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../test/_org-test-db';
import { dreamRegistrationInput, recordDreamRunSpend } from './dream-governor';
import {
  beginDreamRun,
  finalizeDreamRun,
  getDreamRun,
  listDreamRuns,
  recordDreamRunSelection,
} from './dream-run-store';
import type { DreamFragmentPair } from './fragment-sampler';
import { registerLearningLoop } from '../learning-governor/store';
import { rm } from 'node:fs/promises';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { beginDreamRunCall, settleDreamRunCall, recordDreamRunReview } from './dream-run-store';
import { dreamCapabilityRun, dreamCallTotals } from './dream-run-provenance';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMED = path.resolve(HERE, '../../../../libs/papercusp/libs/db/sql/862-dream-runs-ledger.sql');
const MIGRATION_PATH = existsSync(ARMED) ? ARMED : `${ARMED}.DRAFT`;
if (!existsSync(MIGRATION_PATH)) throw new Error(`migration 862 not found at ${ARMED}[.DRAFT]`);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dream-run-store';
const POT = 'papercusp';
const PAIR: DreamFragmentPair = {
  anchor: {
    id: 'recent-observation',
    kind: 'observation',
    ref: 'observation:EI-1',
    text: 'A repeated recovery wake was observed.',
    createdAt: '2026-08-20T12:00:00.000Z',
    harness: POT,
  },
  partner: {
    id: 'remote-memory',
    kind: 'memory',
    ref: 'memory:watermark',
    text: 'A completion watermark suppressed an older replay.',
    createdAt: '2026-07-01T12:00:00.000Z',
    harness: POT,
  },
  pairing: 'banded',
  similarity: 0.61,
};

describe('migration 862 + dream run accounting (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Before arming, the normal fixture deliberately ignores *.DRAFT. After
    // arming, this is an idempotency replay over the already-migrated template.
    await db.adminSql.unsafe(MIGRATION_SQL);
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  it('applies idempotently and keeps the declared mode/status checks armed', async () => {
    await expect(db.adminSql.unsafe(MIGRATION_SQL)).resolves.toBeDefined();
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode)
        VALUES (${WS}, 'invalid-mode', 'cycle-invalid', ${POT}, 'background')`,
    ).rejects.toThrow(/dream_runs_mode_check/);
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status)
        VALUES (${WS}, 'invalid-status', 'cycle-invalid', ${POT}, 'manual', 'forgotten')`,
    ).rejects.toThrow(/dream_runs_status_check/);
  });

  it('persists selection/finalization and makes replayed spend accounting exactly once', async () => {
    await registerLearningLoop(db.adminSql, dreamRegistrationInput({ workspaceId: WS, potSlug: POT }));

    const begun = await beginDreamRun(db.adminSql, {
      workspaceId: WS,
      runId: 'cycle-pg:dream:1',
      cycleId: 'cycle-pg',
      potSlug: POT,
      mode: 'manual',
    });
    expect(begun.created).toBe(true);
    expect(begun.run.status).toBe('running');

    await recordDreamRunSelection(db.adminSql, {
      workspaceId: WS,
      runId: begun.run.runId,
      pair: PAIR,
      dreamerModel: 'claude-haiku-4-5',
    });
    const finalized = await finalizeDreamRun(db.adminSql, {
      workspaceId: WS,
      runId: begun.run.runId,
      status: 'accepted',
      dreamUsage: { model: 'claude-haiku-4-5', costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
      reviewUsage: { model: 'claude-opus-5', costUsd: 0.02, inputTokens: 200, outputTokens: 30 },
      outcome: { verdict: 'insight' },
      review: { verdict: 'accept' },
      routedRef: 'wi:WI-DREAM-PG',
    });
    expect(finalized).toMatchObject({
      status: 'accepted',
      fragmentRefs: [PAIR.anchor.ref, PAIR.partner.ref],
      fragmentKinds: ['observation', 'memory'],
      dreamerModel: 'claude-haiku-4-5',
      reviewerModel: 'claude-opus-5',
      inputTokens: 300,
      outputTokens: 50,
      costUsd: 0.03,
      routedRef: 'wi:WI-DREAM-PG',
    });

    await expect(
      finalizeDreamRun(db.adminSql, {
        workspaceId: WS,
        runId: begun.run.runId,
        status: 'error',
        error: 'replay must not replace accepted',
      }),
    ).resolves.toMatchObject({ status: 'accepted', costUsd: 0.03, routedRef: 'wi:WI-DREAM-PG' });

    await expect(
      recordDreamRunSpend(db.adminSql, { workspaceId: WS, runId: begun.run.runId, potSlug: POT }),
    ).resolves.toEqual({
      recorded: true,
      costUsd: 0.03,
    });
    await expect(
      recordDreamRunSpend(db.adminSql, { workspaceId: WS, runId: begun.run.runId, potSlug: POT }),
    ).resolves.toEqual({
      recorded: false,
      costUsd: 0.03,
      reason: 'already-recorded',
    });

    const [eventCount] = await db.adminSql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM harness_shared.learning_spend_events
       WHERE workspace_id = ${WS} AND loop_id = 'dream:papercusp' AND run_ref = ${begun.run.runId}`;
    const [registration] = await db.adminSql<{ spent_usd: number }[]>`
      SELECT spent_usd
        FROM harness_shared.learning_governor_loops
       WHERE workspace_id = ${WS} AND loop_id = 'dream:papercusp'`;
    expect(eventCount?.count).toBe(1);
    expect(Number(registration?.spent_usd)).toBeCloseTo(0.03);

    await expect(getDreamRun(db.adminSql, { workspaceId: WS, runId: begun.run.runId })).resolves.toMatchObject({
      status: 'accepted',
      spendRecordedAt: expect.any(String),
    });
    await expect(listDreamRuns(db.adminSql, { workspaceId: WS, potSlug: POT })).resolves.toHaveLength(1);
  });

  it('refuses stable run-id reuse with different provenance', async () => {
    await expect(
      beginDreamRun(db.adminSql, {
        workspaceId: WS,
        runId: 'cycle-pg:dream:1',
        cycleId: 'different-cycle',
        potSlug: POT,
        mode: 'manual',
      }),
    ).rejects.toThrow('reused with different provenance');
  });

  it('stores old/new rows together and reconciles every governed phase without double-counting aggregates', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-accounting' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'cap-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      for (const call of f.provenance.calls) {
        const input = {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        };
        const admissions = await Promise.all([
          beginDreamRunCall(db.adminSql, input),
          beginDreamRunCall(db.adminSql, input),
        ]);
        expect(admissions.filter((r) => r.started)).toHaveLength(1);
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      for (const phase of ['packet', 'retrieval', 'rerank'] as const) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: phase, phase, model: 'source-service', reservedUsd: 0.02 },
        });
        await settleDreamRunCall(db.adminSql, {
          ...key,
          callId: phase,
          usage: { model: 'source-service', costUsd: 0.005, inputTokens: 20, outputTokens: 0 },
        });
      }
      await expect(
        finalizeDreamRun(db.adminSql, {
          ...key,
          status: 'rejected',
          dreamUsage: { model: 'dreamer', costUsd: 999, inputTokens: 100, outputTokens: 10 },
        }),
      ).rejects.toThrow('does not reconcile');
      const result = await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'rejected',
        outcome: { verdict: 'insight', insight: f.insight },
        review: { ...f.review, verdict: 'reject', reason: 'counterexample' },
        dreamUsage: f.provenance.calls[0]!.usage,
        reviewUsage: f.review.usage,
      });
      expect(result.costUsd).toBeCloseTo(0.085);
      expect(result.inputTokens).toBe(460);
      expect(result.outputTokens).toBe(40);
      expect(dreamCapabilityRun(result)?.sampling).toEqual(f.sampling);
      expect(dreamCapabilityRun(result)?.calls).toHaveLength(7);
      expect(dreamCallTotals(dreamCapabilityRun(result)!.calls).costBasis).toBe('actual');
      const replay = await finalizeDreamRun(db.adminSql, { ...key, status: 'error', outcome: { replaced: true } });
      expect(replay).toEqual(result);
      expect(
        dreamCapabilityRun((await getDreamRun(db.adminSql, { workspaceId: WS, runId: 'cycle-pg:dream:1' }))!),
      ).toBeNull();
      expect((await listDreamRuns(db.adminSql, { workspaceId: WS, potSlug: POT })).map((r) => r.runId)).toContain(
        key.runId,
      );
      await expect(
        recordDreamRunSelection(db.adminSql, {
          ...key,
          capability: { ...f.sampling, log: { ...f.sampling.log, seed: 'changed' } },
        }),
      ).rejects.toThrow('already frozen');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('reserves an interrupted call exactly once and keeps unknown spend visible after terminal replay', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-crashed-call' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'crash-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      const admission = {
        ...key,
        call: { callId: 'generation', phase: 'generation' as const, model: 'dreamer', reservedUsd: 0.3 },
      };
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(true);
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(false);
      await expect(
        beginDreamRunCall(db.adminSql, { ...admission, call: { ...admission.call, reservedUsd: 0.4 } }),
      ).rejects.toThrow('different admission');
      const result = await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'error',
        error: 'Process died before provider usage returned.',
      });
      expect(result.costUsd).toBe(0.3);
      expect(dreamCallTotals(dreamCapabilityRun(result)!.calls)).toMatchObject({
        costBasis: 'conservative-bound',
        unknownCallIds: ['generation'],
      });
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(false);
      await expect(
        settleDreamRunCall(db.adminSql, {
          ...key,
          callId: 'generation',
          usage: { model: 'dreamer', costUsd: 0.1, inputTokens: 20, outputTokens: 10 },
        }),
      ).rejects.toThrow('terminal');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('freezes the reviewed candidate before the sink and refuses accepted finalization without routing', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-frozen-review' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'freeze-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      const review = { ...key, outcome: { verdict: 'insight', insight: f.insight }, review: { ...f.review } };
      await expect(recordDreamRunReview(db.adminSql, review)).rejects.toThrow('usage does not reconcile');
      for (const call of f.provenance.calls) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      const first = await recordDreamRunReview(db.adminSql, review);
      expect(await recordDreamRunReview(db.adminSql, review)).toEqual(first);
      await expect(
        recordDreamRunReview(db.adminSql, { ...review, review: { ...f.review, note: 'changed' } }),
      ).rejects.toThrow('already frozen');
      await expect(finalizeDreamRun(db.adminSql, { ...key, status: 'accepted' })).rejects.toThrow('reviewed and sunk');
      await expect(
        beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: 'late', phase: 'review', model: 'reviewer', reservedUsd: 0.1 },
        }),
      ).rejects.toThrow('after review');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
