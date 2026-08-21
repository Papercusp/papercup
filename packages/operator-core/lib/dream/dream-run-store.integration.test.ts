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
});
