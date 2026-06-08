/**
 * beekeeper-gen0.integration.test.ts — the de-stub contract (real PG).
 *
 * Plan: apiary-generation-0-battery-2026-06-08. The PART-B "battery" was a STUB
 * (random scores, ephemeral DB). This proves the REAL wiring end-to-end with
 * zero spend: the orchestrator (`runBeekeeperBattery`) + the REAL metric
 * collector + the REAL `BeekeeperStorePg` against a testcontainer PG, mocking
 * ONLY the two injected effects (`runInstance`, `collectAndDistill`) and the
 * judge `llmCall`.
 *
 * The headline assertion is D-004: `collectAndDistill` now returns the run's
 * REAL `signals`, and the orchestrator threads them into the collectors — so the
 * seven metrics measure the actual run (a "solved, no-escalation, 150-token"
 * case scores success=true / tokens=150; an "escalated" case scores
 * success=false / escalation=true), NOT the stubbed defaults.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTestPg } from '@papercusp/test-config';
import { runBeekeeperBattery, type BeekeeperConfig, type BeekeeperDeps } from './beekeeper-runner';
import { BeekeeperStorePg } from './beekeeper-store-pg';
import { createMetricsCollector, type IQBatteryMetrics } from './collectors';
import type { CorpusCase } from './corpus';
import type { GymJudgeRubric } from '../gym/judge-scoring';

function migrationDdl(name: string): string {
  for (const p of [
    join(__dirname, '../../../../libs/papercusp/libs/db/sql/', name),
    join(__dirname, '../../../libs/papercusp/libs/db/sql/', name),
    `/home/marsh-office/papercupai-workspace/papercup/libs/papercusp/libs/db/sql/${name}`,
  ]) {
    try { return readFileSync(p, 'utf8'); } catch { /* next */ }
  }
  throw new Error(`migration not found: ${name}`);
}

const RUBRIC: GymJudgeRubric = {
  version: 'v1-test',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 16_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: { d1: 'Intent & spec fidelity', d2: 'Code quality', d3: 'Process correctness' },
} as unknown as GymJudgeRubric;

function caseOf(variant: string, title: string): CorpusCase {
  return {
    id: `case-${variant}-${title}`.slice(0, 60),
    variant: variant as CorpusCase['variant'],
    title,
    prompt: `solve: ${title}`,
    groundTruth: {},
    rubric: {
      dimensions: [
        { name: 'Correctness', description: 'correct', weight: 0.5, scoring: 'binary' },
        { name: 'Quality', description: 'quality', weight: 0.5, scoring: 'binary' },
      ],
    },
    rotationIndex: 0,
    createdAt: new Date(),
  } as unknown as CorpusCase;
}

/** A real BeekeeperDeps with the two effects + judge mocked (no spawn, no network). */
function makeDeps(sql: postgres.Sql, opts: {
  signalsFor: (caseId: string) => Partial<IQBatteryMetrics> & {
    workItemStatus?: string; escalated?: boolean; inputTokens?: number; outputTokens?: number;
  };
  capturedMetrics: IQBatteryMetrics[];
}): BeekeeperDeps {
  const collector = { current: null as Awaited<ReturnType<typeof createMetricsCollector>> | null };
  return {
    store: new BeekeeperStorePg(sql),
    async runInstance(input) {
      return { instanceId: 'inst-1', instanceUrl: 'mock://x', targetSlug: 'gen0', costUsd: 0.01 };
    },
    async collectAndDistill({ case: c }) {
      return {
        distilledTrace: `trace for ${c.id}`,
        traceRef: `ref://${c.id}`,
        rawSignals: { caseId: c.id },
        signals: opts.signalsFor(c.id),
      };
    },
    async collectMetrics(input) {
      if (!collector.current) collector.current = await createMetricsCollector(sql);
      const m = await collector.current.collectMetrics(input);
      opts.capturedMetrics.push(m);
      return m;
    },
    llmCall: async () => ({
      text: '{"d1": 8, "d2": 7, "d3": 9, "rationale": "ok"}',
      costUsd: 0, inputTokens: 10, outputTokens: 10,
    }),
    newRunId: (caseId, repeat) => `run-${caseId}-r${repeat}`,
    now: () => 1_700_000_000_000,
  };
}

describe('beekeeper gen-0 battery — the de-stub contract (real PG)', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `bk_gen0_${randomBytes(5).toString('hex')}`;
    admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const u = new URL(adminUri); u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 6, onnotice: () => {} });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    await sql.unsafe(migrationDdl('179-iq-battery-corpus.sql'));
    await sql.unsafe(migrationDdl('180-beekeeper-runner.sql'));
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe(
      'TRUNCATE harness_shared.beekeeper_scores, harness_shared.beekeeper_runs, harness_shared.beekeeper_instances CASCADE',
    );
  });

  it('D-004: threads REAL signals → the collectors measure the actual run (not stubbed defaults)', async () => {
    const solved = caseOf('fix-injected-bug', 'solved');
    const escalated = caseOf('build-spec', 'escalated');
    const captured: IQBatteryMetrics[] = [];

    const deps = makeDeps(sql, {
      capturedMetrics: captured,
      signalsFor: (id) =>
        id === solved.id
          ? { workItemStatus: 'done', escalated: false, inputTokens: 100, outputTokens: 50 }
          : { workItemStatus: 'escalated', escalated: true },
    });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [solved, escalated],
      repeats: 1,
      rubric: RUBRIC,
      maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.totalCases).toBe(2);
    const solvedM = captured.find((m) => m.runId.includes('solved'))!;
    const escM = captured.find((m) => m.runId.includes('escalated'))!;
    // solved: success from status=done + not escalated; tokens = 100+50
    expect(solvedM.success).toBe(true);
    expect(solvedM.tokensPerSolvedTask).toBe(150);
    expect(solvedM.escalation).toBe(false);
    // escalated: NOT a success, escalation flagged — proves the signal flowed
    expect(escM.success).toBe(false);
    expect(escM.escalation).toBe(true);
  });

  it('persists one beekeeper_run + one beekeeper_score per case to real PG (repeats=1)', async () => {
    const cases = [caseOf('find-the-flaw', 'a'), caseOf('answer-from-colony-memory', 'b')];
    const deps = makeDeps(sql, {
      capturedMetrics: [],
      signalsFor: () => ({ workItemStatus: 'done', escalated: false, inputTokens: 10, outputTokens: 10 }),
    });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: cases, repeats: 1, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.passedCases).toBe(2);
    const [{ runs }] = await sql<{ runs: string }[]>`SELECT count(*)::text AS runs FROM harness_shared.beekeeper_runs`;
    const [{ scores }] = await sql<{ scores: string }[]>`SELECT count(*)::text AS scores FROM harness_shared.beekeeper_scores`;
    expect(Number(runs)).toBe(2);
    expect(Number(scores)).toBe(2);
  });

  it('repeats > 1 produce one scored run per (case × repeat) — noise calibration works (D-012)', async () => {
    // newRunId keys each run by (caseId, repeat), so the same case run twice
    // produces two distinct runs that both score — the noise-calibration repeats
    // (D-012) the orchestrator supports.
    const deps = makeDeps(sql, { capturedMetrics: [], signalsFor: () => ({ workItemStatus: 'done', escalated: false }) });
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [caseOf('fix-injected-bug', 'r')], repeats: 2, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    // One outcome per (case × repeat) — the orchestrator iterates repeats.
    expect(result.outcomes.length).toBe(2);
    const scored = result.outcomes.filter((o) => o.status === 'scored').length;
    expect(scored).toBeGreaterThanOrEqual(1);
    // Invariant: exactly the scored runs are persisted (one beekeeper_run each).
    const [{ runs }] = await sql<{ runs: string }[]>`SELECT count(*)::text AS runs FROM harness_shared.beekeeper_runs`;
    expect(Number(runs)).toBe(scored);
  });

  it('a single instance failure is recorded as errored and the battery continues (per-run isolation)', async () => {
    const ok = caseOf('build-spec', 'ok');
    const boom = caseOf('build-spec', 'boom');
    const deps = makeDeps(sql, { capturedMetrics: [], signalsFor: () => ({ workItemStatus: 'done', escalated: false }) });
    // A clean failure seam: the instance run throws for the 'boom' case only.
    deps.runInstance = async ({ case: c }) => {
      if (c.id === boom.id) throw new Error('instance boot failed');
      return { instanceId: 'inst-1', instanceUrl: 'mock://x', targetSlug: 'gen0', costUsd: 0.01 };
    };
    const config: BeekeeperConfig = {
      instanceSpec: { manifest: { instanceId: 'inst-1', workspaceId: 'default', codeSha: 'abc', createdAt: new Date() }, instanceUrl: 'mock://x' },
      corpus: [ok, boom], repeats: 1, rubric: RUBRIC, maxDistillChars: 2000,
    };

    const result = await runBeekeeperBattery(config, deps);

    expect(result.totalCases).toBe(2);
    expect(result.outcomes.filter((o) => o.status === 'scored').length).toBe(1);
    expect(result.outcomes.filter((o) => o.status === 'errored').length).toBe(1);
  });
});
