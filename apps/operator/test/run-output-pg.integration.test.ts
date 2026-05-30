/**
 * run-output-pg.integration.test.ts — real-Postgres coverage for the canonical
 * completed-run record (P-008, Phase 1).
 *
 * At subprocess exit the orchestrator UPSERTs one row per run into
 * harness_run_output; the operator's post-hoc LogView reads it back. The
 * correctness that matters is the UPSERT's column-set on conflict (it updates
 * bodies + ended_at but NOT started_at), the null exit_code/duration_ms
 * coercion, and the BIGINT timestamp coercion — none exercised by makeMockPg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  RUN_OUTPUT_DDL,
  recordRunOutputPg,
  readRunOutputPg,
  type RunOutputPgContext,
  type RunOutputRow,
} from '../../../libs/papercusp/packages/orchestrator/src/run-output-pg';

let db: FreshPgDb;

const ctx = (): RunOutputPgContext => ({
  pg: db.sql as unknown as RunOutputPgContext['pg'],
  workspaceId: 'ws_test',
  harnessSlug: 'demo',
});
const rid = () => `run_${randomBytes(5).toString('hex')}`;
const sample = (runId: string): RunOutputRow => ({
  runId,
  role: 'worker',
  promptBody: 'the prompt',
  jsonlBody: '{"event":"start"}',
  outBody: 'stdout body',
  errBody: 'stderr body',
  exitCode: 0,
  durationMs: 1234,
  startedAt: 1000,
  endedAt: 2000,
});

beforeAll(async () => {
  db = await createFreshPgDb('ro');
  await db.sql.unsafe(RUN_OUTPUT_DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('run-output-pg against real Postgres', () => {
  it('round-trips a recorded run exactly', async () => {
    const c = ctx();
    const runId = rid();
    const row = sample(runId);
    await recordRunOutputPg(c, row);
    expect(await readRunOutputPg(c, runId)).toEqual(row);
  });

  it('returns null for an unknown run', async () => {
    expect(await readRunOutputPg(ctx(), rid())).toBeNull();
  });

  it('UPSERT updates bodies + ended_at but preserves the original started_at', async () => {
    const c = ctx();
    const runId = rid();
    await recordRunOutputPg(c, sample(runId));
    await recordRunOutputPg(c, { ...sample(runId), outBody: 'UPDATED', endedAt: 9999, startedAt: 5555 });
    const got = await readRunOutputPg(c, runId);
    expect(got?.outBody).toBe('UPDATED');
    expect(got?.endedAt).toBe(9999);
    // started_at is intentionally NOT in the ON CONFLICT update set.
    expect(got?.startedAt).toBe(1000);
  });

  it('coerces null exit_code / duration_ms to 0 on read', async () => {
    const c = ctx();
    const runId = rid();
    await recordRunOutputPg(c, {
      ...sample(runId),
      exitCode: null as unknown as number,
      durationMs: null as unknown as number,
    });
    const got = await readRunOutputPg(c, runId);
    expect(got?.exitCode).toBe(0);
    expect(got?.durationMs).toBe(0);
  });

  it('isolates by run_id', async () => {
    const c = ctx();
    const a = rid();
    const b = rid();
    await recordRunOutputPg(c, { ...sample(a), outBody: 'A' });
    await recordRunOutputPg(c, { ...sample(b), outBody: 'B' });
    expect((await readRunOutputPg(c, a))?.outBody).toBe('A');
  });
});
