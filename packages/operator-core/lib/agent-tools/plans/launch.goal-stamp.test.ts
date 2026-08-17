/**
 * plans:launch × plan goal provenance (migration 791, goal-mode-design-intent-
 * hardening-2026-08-16 P-003).
 *
 * plans:new stamps `harness_plans.goal_id` at create; launch is the second
 * attribution point — a goal agent frequently launches a plan authored OUTSIDE
 * its goal (a template, a peer's plan), and without a launch-time stamp that
 * plan is invisible on the goal page while the goal's own agent is driving it.
 * What these tests pin:
 *
 *   1. the stamp is written from the launcher's RESOLVED plan scope (the pair
 *      `resolvePlanScope` returns — pot-collapsed), NOT the caller's raw
 *      harness slug — the raw slug misses pot-scoped plans SILENTLY (zero-row
 *      UPDATE), the exact trap new.ts:492-495 documents;
 *   2. the goal is derived from the launcher's IDENTITY (resolveGoalContext
 *      inside the helper) — no tool argument can name a goal, on plans:launch
 *      OR plans:new (the schema-immunity tests below fail if anyone adds one);
 *   3. provenance is best-effort: a scope/stamp failure never fails a launch
 *      that already succeeded.
 *
 * Mocks every heavy collaborator (same discipline as new.workspace-id.test.ts)
 * so this stays a pure handler-shape unit test. Run:
 *   npm run test:file -- packages/operator-core/lib/agent-tools/plans/launch.goal-stamp.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { AgentIdentity } from '../coordination/identity';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'member-harness') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string | undefined, ctx: unknown) => ctx,
}));
vi.mock('./plan-start-gate', () => ({
  checkPlanStartable: vi.fn(async () => ({ ok: true, inputs: null })),
}));
vi.mock('./context-bundle', () => ({
  buildPlanContextBundle: vi.fn(async () => ({
    title: 'The plan',
    contentHash: 'hash-1',
    status: 'active',
    text: 'SYSTEM PROMPT',
  })),
}));
vi.mock('./runs', () => ({ insertPlanRun: vi.fn(async () => 41) }));
vi.mock('./turn', () => ({
  executePlanAgentTurn: vi.fn(async () => ({ status: 'completed', costUsd: 0 })),
}));
// Typed factory, not a cast: the fixture stays checked against AgentIdentity,
// so a field added to the real interface strands HERE at tsc (a one-line fix)
// instead of at runtime in the gate. vi.hoisted because the vi.mock factory
// below (which is hoisted above every const) closes over it.
const launcherIdentity = vi.hoisted(
  () =>
    (over: Partial<AgentIdentity> = {}): AgentIdentity =>
      // Object.assign, not spread: spreading a Partial<T> over the defaults
      // re-widens every required field to `| undefined` and the result stops
      // being assignable to T. Object.assign keeps the intersection type.
      Object.assign(
        {
          ownerId: 'launcher-1',
          ownerLabel: 'launcher',
          source: 'omp-hook-session' as const,
          workspaceId: null,
        },
        over,
      ),
);
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => launcherIdentity()),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
// `source` serves BOTH tools under test: launch.ts reads resolvePlanScope +
// getRepoRoot; new.ts (imported for the schema-immunity tests) reads
// listPlanIndexRows.
vi.mock('./source', () => ({
  getRepoRoot: vi.fn(() => '/tmp'),
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-1', harnessSlug: 'hive-home' })),
  listPlanIndexRows: vi.fn(async () => []),
}));
vi.mock('../../modes/goal-context', () => ({
  stampPlanGoalProvenance: vi.fn(async () => 'goal-42'),
}));
// new.ts-only collaborators (schema-immunity tests import its tool object).
vi.mock('./revisions', () => ({
  planRevisionCapture: vi.fn(() => ({ recorded: { current: null }, afterWrite: vi.fn() })),
}));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn(async () => {}) }));
vi.mock('./item-parse-feedback', () => ({ summarizeItemParse: vi.fn(() => ({})) }));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(async () => ({
    kind: 'applied',
    value: { ok: true, slug: 'demo-plan' },
    filePath: 'x',
    version: 1,
    scope: { workspaceId: 'ws-1', harnessSlug: 'hive-home' },
  })),
}));

const { resolvePlanScope } = await import('./source');
const { stampPlanGoalProvenance } = await import('../../modes/goal-context');
const { resolveAgentIdentity } = await import('../coordination/identity');
const launchTool = (await import('./launch')).default;
const newTool = (await import('./new')).default;

const resolveScopeM = vi.mocked(resolvePlanScope);
const stampM = vi.mocked(stampPlanGoalProvenance);
const identityM = vi.mocked(resolveAgentIdentity);

type Out = { content: { text: string }[]; isError?: boolean };
const launch = (extra: Record<string, unknown> = {}) =>
  (launchTool as { handler: (a: never, c: never) => Promise<Out> }).handler(
    { harness: 'member-harness', slug: 'the-plan', ...extra } as never,
    { emit: vi.fn(), metadata: vi.fn() } as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  resolveScopeM.mockResolvedValue({ workspaceId: 'ws-1', harnessSlug: 'hive-home' });
  stampM.mockResolvedValue('goal-42');
  identityM.mockReturnValue(launcherIdentity());
});

describe('plans:launch stamps plan goal provenance from the RESOLVED scope + launcher identity', () => {
  it('calls the stamp with the pot-collapsed scope pair and the launcher ownerId', async () => {
    const out = await launch();
    expect(out.isError).toBeUndefined();
    // The stamp is deliberately un-awaited by the handler — flush it.
    await vi.waitFor(() => expect(stampM).toHaveBeenCalledTimes(1));
    expect(stampM).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      // The RESOLVED hive-home slug — NOT the caller's 'member-harness'. Using
      // the raw slug would zero-row the UPDATE on exactly the pot-scoped plans
      // a goal creates (the silent-miss trap).
      harnessSlug: 'hive-home',
      planSlug: 'the-plan',
      ownerId: 'launcher-1',
    });
  });

  it('an unattributable launcher stamps with no ownerId — the helper then no-ops', async () => {
    identityM.mockImplementation(() => {
      throw new Error('no identity');
    });
    const out = await launch();
    expect(out.isError).toBeUndefined();
    await vi.waitFor(() => expect(stampM).toHaveBeenCalledTimes(1));
    expect(stampM.mock.calls[0]![0]).toMatchObject({ ownerId: undefined });
  });

  it('a scope-resolution failure skips the stamp without failing the launch', async () => {
    resolveScopeM.mockRejectedValue(new Error('unregistered harness'));
    const out = await launch();
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0]!.text) as { runId: number; status: string };
    expect(body.runId).toBe(41);
    // Give the void IIFE a tick — the stamp must never have fired.
    await new Promise((r) => setImmediate(r));
    expect(stampM).not.toHaveBeenCalled();
  });

  it('a stamp failure never fails the launch', async () => {
    stampM.mockRejectedValue(new Error('pg down'));
    const out = await launch();
    expect(out.isError).toBeUndefined();
    await vi.waitFor(() => expect(stampM).toHaveBeenCalledTimes(1));
  });
});

describe('no tool argument can name a goal (D-005 self-report immunity)', () => {
  // The operative clause of migration 791 (and P-003): the stamp is written from
  // RESOLVED context, "never from an argument, so a plan cannot self-report its
  // way onto a goal". These fail the moment anyone adds a goal-shaped arg to
  // either tool's schema — forcing a deliberate revisit of that rule.
  const schemas: Array<[string, z.ZodObject<z.ZodRawShape>]> = [
    ['plans:launch', (launchTool as { args: z.ZodObject<z.ZodRawShape> }).args],
    ['plans:new', (newTool as { args: z.ZodObject<z.ZodRawShape> }).args],
  ];

  it.each(schemas)('%s declares no goal-shaped argument', (_name, schema) => {
    expect(schema).toBeDefined();
    const goalish = Object.keys(schema.shape).filter((k) => /goal/i.test(k));
    expect(goalish).toEqual([]);
  });

  it('the schema REJECTS a smuggled goal key outright (strict — not even stripped)', () => {
    const schema = (launchTool as { args: z.ZodObject<z.ZodRawShape> }).args;
    const res = schema.safeParse({
      harness: 'member-harness',
      slug: 'the-plan',
      goalId: 'goal-evil',
      goal_id: 'goal-evil',
      goal: 'goal-evil',
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(!res.success ? res.error.issues : [])).toMatch(/unrecognized_keys/);
    // Control: the same input without the smuggled keys parses fine — the
    // rejection above is about the keys, not the fixture.
    expect(schema.safeParse({ harness: 'member-harness', slug: 'the-plan' }).success).toBe(true);
  });
});
