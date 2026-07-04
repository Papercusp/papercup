/**
 * background-settle.integration.test.ts — await:false runs must not dangle
 * `running` when the background turn fails (P2-4).
 *
 * plans:launch and plans:resume both support `await: false` (the admin-UI POST
 * path, D-022): they kick `void executePlanAgentTurn(...).catch(()=>{})` and
 * return immediately with `status: running` + the runId. The UI then polls the
 * run store. The invariant: a FAILING background turn must still settle the row
 * to `failed` — a turn that errors and leaves the row stuck `running` forever is
 * a dangling-run bug (the orphan sweep is only a 30-min backstop).
 *
 * This drives the REAL executePlanAgentTurn + the REAL run-store settle against
 * Postgres (shared baseline-schema fixture); only the agent runner is stubbed —
 * to yield an `error` event, exactly the shape a backend failure produces. We
 * then poll getPlanRun until the row settles, asserting it reaches `failed`.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/background-settle.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

// Stub ONLY the agent runner: yield an error event so the REAL
// executePlanAgentTurn settles the run to `failed`. Async-generator shape
// matches runPlanAgent's `AsyncGenerator<ChatEvent>`.
vi.mock('../runner', () => ({
   
  runPlanAgent: async function* () {
    yield { type: 'error', message: 'forced backend failure for P2-4' } as const;
  },
}));

// Re-seed bundle so launch/resume don't read a real plan doc.
const BUNDLE = {
  text: 'system seed',
  slug: '',
  title: 'T',
  status: 'ready' as const,
  archived: false,
  contentHash: 'd'.repeat(64),
  rationaleCount: 0,
};
vi.mock('../context-bundle', () => ({
  buildPlanContextBundle: vi.fn(async (slug: string) => ({ ...BUNDLE, slug })),
}));

vi.mock('../source', async (orig) => {
  const actual = await orig<typeof import('../source')>();
  return { ...actual, getRepoRoot: () => '/tmp' };
});

import launchTool from '../launch';
import resumeTool from '../resume';
import { getPlanRun, insertPlanRun } from '../runs';

const HARNESS = `zzz-bgsettle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = `bg-settle-${Date.now()}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;

const MAKE_CTX = () =>
  ({
    emit: vi.fn(),
    signal: new AbortController().signal,
    uiClientId: null,
    harnessSlug: HARNESS,
  } as never);

/** Poll the run store until `status` settles to a non-running value, or time out. */
async function waitForSettle(runId: number, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
   
  while (true) {
    const row = await getPlanRun(runId);
    if (row && row.status !== 'running') return row.status;
    if (Date.now() > deadline) return row?.status ?? 'missing';
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.plan_run_turns
     WHERE plan_run_id IN (SELECT id FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS})
  `.catch(() => {});
  await admin`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`.catch(() => {});
  await fx?.dispose();
});

describe('await:false background turn settles to failed (P2-4)', () => {
  it('plans:launch await:false returns running immediately, then the failing turn settles to failed', async () => {
    const res = (await launchTool.handler(
      { harness: HARNESS, slug: SLUG, await: false } as never,
      MAKE_CTX(),
    )) as { content: { text: string }[]; isError?: boolean };

    const data = JSON.parse(res.content[0].text);
    // Immediate return: running + a real runId, in background mode.
    expect(data).toMatchObject({ status: 'running', mode: 'background', planSlug: SLUG });
    expect(typeof data.runId).toBe('number');

    // The background turn fails (stubbed runner errors) → the row must settle.
    const settled = await waitForSettle(data.runId);
    expect(settled).toBe('failed');
  }, 20_000);

  it('plans:resume await:false settles a failing background turn to failed (not stuck running)', async () => {
    // Seed an idle (resumable) run, then resume it in the background.
    const runId = await insertPlanRun({
      planSlug: SLUG,
      harnessSlug: HARNESS,
      planContentHash: 'a'.repeat(64),
      sessionId: crypto.randomUUID(),
      note: null,
      launchedBy: 'test@example.com',
      title: 'resume-bg',
      status: 'idle',
    });

    const res = (await resumeTool.handler(
      { harness: HARNESS, runId, message: 'continue', await: false } as never,
      MAKE_CTX(),
    )) as { content: { text: string }[]; isError?: boolean };

    expect(res.isError).toBeUndefined();
    const data = JSON.parse(res.content[0].text);
    expect(data).toMatchObject({ runId, status: 'running', mode: 'background' });

    const settled = await waitForSettle(runId);
    expect(settled).toBe('failed');
  }, 20_000);
});
