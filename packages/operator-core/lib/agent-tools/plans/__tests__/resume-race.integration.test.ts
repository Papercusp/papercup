/**
 * resume-race.integration.test.ts — plans:resume must not double-execute a run
 * that is already `running` (P1-1).
 *
 * Two concurrent resumes on the SAME run row would each have called the old
 * unconditional `markPlanRunResumed` (status := 'running' regardless of prior
 * status) and then kicked `executePlanAgentTurn` — spawning two agent turns on
 * one session, racing them onto one transcript. The fix makes the resume CLAIM
 * atomic: `markPlanRunResumed` only flips a run that is NOT already `running`
 * and returns `{ claimed }`; the handler refuses (run_busy) when it loses.
 *
 * This drives the REAL claim against real Postgres (the `_pg-tool-fixture`
 * baseline schema) — only the agent turn + context bundle are stubbed, so the
 * row-level race is exercised exactly as production hits it.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/resume-race.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

// Stub the agent turn so resuming never spawns a real agent. The spy counts
// how many turns were kicked — the load-bearing assertion (no duplicate turn).
const turnSpy = vi.fn(async () => ({ status: 'idle' as const, costUsd: 0, finalText: 'ok' }));
vi.mock('../turn', () => ({
  executePlanAgentTurn: (...args: unknown[]) => turnSpy(...(args as [])),
}));

// Re-seed bundle: a fixed content hash so the resume re-stamp is deterministic.
const BUNDLE = {
  text: 'system seed',
  slug: '',
  title: 'T',
  status: 'ready' as const,
  archived: false,
  contentHash: 'f'.repeat(64),
  rationaleCount: 0,
};
vi.mock('../context-bundle', () => ({
  buildPlanContextBundle: vi.fn(async (slug: string) => ({ ...BUNDLE, slug })),
}));

// getRepoRoot is the only thing resume reads from ../source; keep the rest real.
vi.mock('../source', async (orig) => {
  const actual = await orig<typeof import('../source')>();
  return { ...actual, getRepoRoot: () => '/tmp' };
});

import tool from '../resume';
import { insertPlanRun, getPlanRun } from '../runs';

const HARNESS = `zzz-resrace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = `resume-race-${Date.now()}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;

const MAKE_CTX = () =>
  ({
    emit: vi.fn(),
    signal: new AbortController().signal,
    uiClientId: null,
    harnessSlug: HARNESS,
  } as never);

const resume = async (args: Record<string, unknown>) =>
  (await tool.handler({ harness: HARNESS, ...args } as never, MAKE_CTX())) as {
    content: { text: string }[];
    isError?: boolean;
  };

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterEach(() => {
  turnSpy.mockClear();
});

afterAll(async () => {
  await admin`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`.catch(() => {});
  await fx?.dispose();
});

async function seedRunningRun(): Promise<number> {
  return insertPlanRun({
    planSlug: SLUG,
    harnessSlug: HARNESS,
    planContentHash: 'a'.repeat(64),
    sessionId: crypto.randomUUID(),
    note: null,
    launchedBy: 'test@example.com',
    title: 'race',
    status: 'running',
  });
}

describe('plans:resume race guard (P1-1)', () => {
  beforeEach(() => {
    turnSpy.mockClear();
  });

  it('refuses to resume a run that is already running (no turn kicked)', async () => {
    const runId = await seedRunningRun();
    const res = await resume({ runId, message: 'continue', await: false });

    expect(res.isError).toBe(true);
    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ error: 'run_busy', runId, status: 'running' });
    // The guard returns BEFORE kicking a turn.
    expect(turnSpy).not.toHaveBeenCalled();
    // The row stays running — the loser did not corrupt it.
    expect((await getPlanRun(runId))!.status).toBe('running');
  });

  it('two concurrent resumes on one running run execute AT MOST one turn', async () => {
    const runId = await seedRunningRun();

    const [a, b] = await Promise.all([
      resume({ runId, message: 'A', await: false }),
      resume({ runId, message: 'B', await: false }),
    ]);

    const outcomes = [a, b].map((r) => ({ isError: !!r.isError, data: JSON.parse(r.content[0].text) }));
    const busy = outcomes.filter((o) => o.data.error === 'run_busy');
    const ran = outcomes.filter((o) => !o.isError);

    // A run seeded `running` is already claimed → BOTH concurrent resumes lose
    // the atomic claim and refuse. The invariant under test: never more than
    // one turn is kicked for a single running run.
    expect(turnSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(busy.length).toBe(2 - ran.length);
    // No duplicate execution: the count of kicked turns matches the winners.
    expect(turnSpy.mock.calls.length).toBe(ran.length);
  });

  it('a resume of a SETTLED (idle) run claims it and kicks exactly one turn', async () => {
    const runId = await seedRunningRun();
    // Settle it to idle (resumable, D-010).
    await admin`UPDATE harness_shared.plan_runs SET status = 'idle' WHERE id = ${runId}`;

    const res = await resume({ runId, message: 'go', await: false });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ runId, status: 'running' });
    expect(turnSpy).toHaveBeenCalledTimes(1);
    // The claim flipped idle → running.
    expect((await getPlanRun(runId))!.status).toBe('running');
  });

  it('two concurrent resumes on an IDLE run let exactly one win', async () => {
    const runId = await seedRunningRun();
    await admin`UPDATE harness_shared.plan_runs SET status = 'idle' WHERE id = ${runId}`;

    const [a, b] = await Promise.all([
      resume({ runId, message: 'A', await: false }),
      resume({ runId, message: 'B', await: false }),
    ]);

    const outcomes = [a, b].map((r) => ({ isError: !!r.isError, data: JSON.parse(r.content[0].text) }));
    const winners = outcomes.filter((o) => !o.isError);
    const losers = outcomes.filter((o) => o.data.error === 'run_busy');

    // Exactly one resume claims the idle run; the other is told it is busy.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // And exactly one turn was kicked — no duplicate execution.
    expect(turnSpy).toHaveBeenCalledTimes(1);
  });
});
