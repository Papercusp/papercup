/**
 * decision-model-ledger.integration.test.ts — the P-003 live leg against a real
 * Postgres (plan jev-decision-model-integration-2026-09-29; table: migration 1246
 * harness_shared.decision_model_calls).
 *
 * The schema comes from the REAL migration file, not a hand-copied CREATE TABLE,
 * so a later column change cannot leave this fixture silently one behind.
 *
 * What a fake-sql unit test can't prove and this does:
 *   • every entry field lands in the right column with the right type (text[],
 *     jsonb, numeric, timestamptz) and round-trips;
 *   • the table's CHECK constraints accept what the writer produces for both
 *     outcomes (a writer/constraint mismatch would silently drop every row);
 *   • END TO END: a real createDecisionClient with onCall = recordDecisionModelCall
 *     writes a row per call, answered AND inconclusive, and the judged text is in
 *     NO column (D-006).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';
import {
  createDecisionClient,
  createJevProvider,
  stateSha256,
  type DecisionCallRecord,
  type FetchLike,
} from '@papercusp/decision-model';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-ledger-test' }));

const { recordDecisionModelCall, decisionModelLedgerStats, __resetDecisionModelLedgerStatsForTest } = await import(
  './decision-model-ledger'
);

const MIGRATION = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1246-decision-model-calls.sql', import.meta.url),
);

const SECRET = 'my bank PIN is 4417';

const request = {
  state: { turn: SECRET, memory: 'User prefers dark mode' },
  questions: {
    relevant: {
      type: 'choice',
      instructions: 'Is this memory relevant to the turn?',
      options: { relevant: 'Helps answer', irrelevant: null },
    },
    urgent: { type: 'yesNo', instructions: 'Urgent?' },
  },
} as const;

const JEV_OK = {
  model: 'jev-1.13.0',
  answers: {
    relevant: { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.9, irrelevant: 0.1 }, confidence: 0.8 },
    urgent: { type: 'noul', noul: 0.2 },
  },
  usage: { input_tokens: 250, output_tokens: 18 },
};

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dmc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(readFileSync(MIGRATION, 'utf8'));
  h.sql = rootSql;
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  __resetDecisionModelLedgerStatsForTest();
  await rootSql`TRUNCATE harness_shared.decision_model_calls`;
});

function jevFetch(status: number, body: unknown): FetchLike {
  return async () => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
}

/** The client's observer is fire-and-forget; wait for the row it writes. */
async function rows(expected: number) {
  for (let i = 0; i < 50; i++) {
    const r = await rootSql`SELECT * FROM harness_shared.decision_model_calls ORDER BY id`;
    if (r.length >= expected) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  return rootSql`SELECT * FROM harness_shared.decision_model_calls ORDER BY id`;
}

describe('decision_model_calls writer (real Postgres, real migration)', () => {
  it('an answered call round-trips every column', async () => {
    const record: DecisionCallRecord = {
      provider: 'typesafe',
      requestedModel: 'jev-1.13.0',
      request,
      outcome: {
        kind: 'answered',
        model: 'jev-1.13.0',
        answers: {
          relevant: { type: 'choice', choice: 'relevant', probabilities: { relevant: 0.9, irrelevant: 0.1 }, confidence: 0.8 },
          urgent: { type: 'yesNo', pYes: 0.2 },
        },
        usage: { inputTokens: 250, outputTokens: 18 },
        latencyMs: 181.4,
        attempts: 1,
      },
      startedAt: new Date('2026-09-30T02:00:00.000Z'),
      consumer: 'memory-injection',
      subjectIds: ['mem-1', 'mem-2'],
    };
    await expect(
      recordDecisionModelCall(record, { pricing: { inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8 } }),
    ).resolves.toBe(true);
    const [row] = await rows(1);
    expect(row).toMatchObject({
      workspace_id: 'ws-ledger-test',
      consumer: 'memory-injection',
      provider: 'typesafe',
      requested_model: 'jev-1.13.0',
      returned_model: 'jev-1.13.0',
      question_ids: ['relevant', 'urgent'],
      option_order: { relevant: ['relevant', 'irrelevant'] },
      outcome: 'answered',
      inconclusive_reason: null,
      http_status: null,
      attempts: 1,
      latency_ms: 181,
      input_tokens: 250,
      output_tokens: 18,
      subject_ids: ['mem-1', 'mem-2'],
      state_sha256: stateSha256(request.state),
    });
    expect(row!.answers).toMatchObject({ relevant: { choice: 'relevant', confidence: 0.8 }, urgent: { pYes: 0.2 } });
    expect(Number(row!.cost_usd)).toBeCloseTo((250 * 2 + 18 * 8) / 1e6, 8);
    expect((row!.started_at as Date).toISOString()).toBe('2026-09-30T02:00:00.000Z');
    expect(decisionModelLedgerStats()).toMatchObject({ written: 1, failed: 0 });
  });

  it('end to end: the client observer writes answered AND inconclusive rows, and no column holds the judged text', async () => {
    const answeredClient = createDecisionClient({
      provider: createJevProvider(),
      resolveKey: () => 'ts-test-key',
      fetch: jevFetch(200, JEV_OK),
      onCall: (r) => recordDecisionModelCall(r).then(() => undefined),
    });
    const out = await answeredClient.decide(request, { consumer: 'memory-injection', subjectIds: ['mem-9'] });
    expect(out.kind).toBe('answered');

    const keyless = createDecisionClient({
      provider: createJevProvider(),
      resolveKey: () => null,
      fetch: jevFetch(200, JEV_OK),
      onCall: (r) => recordDecisionModelCall(r).then(() => undefined),
    });
    expect((await keyless.decide(request, { consumer: 'memory-injection' })).kind).toBe('inconclusive');

    const rejecting = createDecisionClient({
      provider: createJevProvider(),
      resolveKey: () => 'ts-test-key',
      fetch: jevFetch(422, { error: `bad state: ${SECRET}` }),
      onCall: (r) => recordDecisionModelCall(r).then(() => undefined),
    });
    expect((await rejecting.decide(request, { consumer: 'memory-injection' })).kind).toBe('inconclusive');

    const all = await rows(3);
    expect(all.map((r) => [r.outcome, r.inconclusive_reason, r.http_status])).toEqual([
      ['answered', null, null],
      ['inconclusive', 'no-key', null],
      ['inconclusive', 'rejected', 422],
    ]);
    expect(all[0]!.subject_ids).toEqual(['mem-9']);
    expect(all[2]!.inconclusive_detail).toBeNull();

    const dump = JSON.stringify(await rootSql`SELECT row_to_json(c) AS j FROM harness_shared.decision_model_calls c`);
    expect(dump).not.toContain('4417');
    expect(dump).not.toContain('dark mode');
    // Positive control: the same dump DOES contain values that are meant to be stored.
    expect(dump).toContain('memory-injection');
    expect(dump).toContain(stateSha256(request.state));
  });

  it('a missing table is swallowed and counted, and the decision still returns', async () => {
    await rootSql`ALTER TABLE harness_shared.decision_model_calls RENAME TO decision_model_calls_away`;
    try {
      const client = createDecisionClient({
        provider: createJevProvider(),
        resolveKey: () => 'ts-test-key',
        fetch: jevFetch(200, JEV_OK),
        onCall: (r) => recordDecisionModelCall(r).then(() => undefined),
      });
      expect((await client.decide(request)).kind).toBe('answered');
      for (let i = 0; i < 50 && decisionModelLedgerStats().failed === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(decisionModelLedgerStats()).toMatchObject({ written: 0, failed: 1 });
    } finally {
      await rootSql`ALTER TABLE harness_shared.decision_model_calls_away RENAME TO decision_model_calls`;
    }
  });
});
