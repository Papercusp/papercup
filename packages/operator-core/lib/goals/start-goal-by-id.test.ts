/**
 * start-goal-by-id.test.ts — the P-020 activation primitive's contract
 * (work-on-everything-goal-2026-08-23 P-020, D-006).
 *
 * Everything is injected: the goal-row read rides a fake sql tag, the
 * launch/holders/readiness/attach legs ride StartGoalByIdDeps. Readiness
 * fixtures are built with the REAL `goalReadiness` fold rather than
 * hand-written literals, so a change to the fold's satisfied/pending
 * semantics (e.g. P-019's plan-status mapping) is felt here instead of
 * silently diverging from a stale fixture.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { goalReadiness } from '@papercusp/agent-mcp/goal-deps';
import type { GoalHolders, ResolvedGoalHolder } from './holder';
import {
  startGoalById,
  type StartGoalByIdDeps,
  type StartGoalByIdInput,
} from './start-goal-by-id';

type GoalRow = { id: string; title: string; status: string; install_slug: string | null };

const WS = 'ws-1';
const GOAL = 'fix-the-roof-a1b2c3';

function fakeSql(rows: GoalRow[]): Sql {
  return ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as Sql;
}

function goalRow(overrides: Partial<GoalRow> = {}): GoalRow {
  return { id: GOAL, title: 'Fix the roof', status: 'active', install_slug: 'papercusp', ...overrides };
}

function holder(overrides: Partial<ResolvedGoalHolder> = {}): ResolvedGoalHolder {
  return {
    goalId: GOAL,
    workspaceId: WS,
    ownerId: 'su-old-holder',
    setAtMs: 1,
    setBy: null,
    sessionState: null,
    selfWake: null,
    live: null,
    ...overrides,
  };
}

function holdersFixture(
  liveness: GoalHolders['liveness'],
  rows: ResolvedGoalHolder[] = [],
): GoalHolders {
  return {
    goalId: GOAL,
    workspaceId: WS,
    holders: rows,
    live: rows.filter((r) => r.live === true),
    liveness,
  };
}

const READY = goalReadiness([]);
const BLOCKED = goalReadiness([{ kind: 'plan', ref: 'plan:papercusp/some-prereq', status: 'draft' }]);

function makeDeps(overrides: Partial<StartGoalByIdDeps> = {}): {
  deps: StartGoalByIdDeps;
  launch: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
} {
  const launch = vi.fn().mockResolvedValue({ ownerId: 'su-new-holder', warnings: ['w1'] });
  const attach = vi.fn().mockResolvedValue({ ok: true, error: null });
  const deps: StartGoalByIdDeps = {
    launch,
    attach,
    resolveHolders: vi.fn().mockResolvedValue(holdersFixture('unheld')),
    readReadiness: vi.fn().mockResolvedValue(READY),
    ...overrides,
  };
  return { deps, launch, attach };
}

function run(
  deps: StartGoalByIdDeps,
  opts: { rows?: GoalRow[]; input?: Partial<StartGoalByIdInput> } = {},
) {
  return startGoalById(fakeSql(opts.rows ?? [goalRow()]), { workspaceId: WS, goalId: GOAL, ...opts.input }, deps);
}

describe('startGoalById — the idempotence guard (D-006)', () => {
  it('refuses a goal that does not exist, launching nothing', async () => {
    const { deps, launch } = makeDeps();
    const res = await run(deps, { rows: [] });
    expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['paused', 'achieved', 'killed'] as const)(
    "refuses a '%s' goal — activation never resurrects a non-active goal",
    async (status) => {
      const { deps, launch } = makeDeps();
      const res = await run(deps, { rows: [goalRow({ status })] });
      expect(res).toMatchObject({ ok: false, reason: 'not-active' });
      expect(res.ok === false && res.detail).toContain(status);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('refuses a goal with no install_slug — no harness to launch into', async () => {
    const { deps, launch } = makeDeps();
    const res = await run(deps, { rows: [goalRow({ install_slug: null })] });
    expect(res).toMatchObject({ ok: false, reason: 'no-harness' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a goal with a LIVE holder, naming the holder', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi
        .fn()
        .mockResolvedValue(holdersFixture('held', [holder({ ownerId: 'su-alive', live: true })])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'already-held' });
    expect(res.ok === false && res.detail).toContain('su-alive');
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses on UNKNOWN holder liveness — degraded evidence is not absence', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi.fn().mockResolvedValue(holdersFixture('unknown', [holder()])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'holder-unknown' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('proceeds past a LOST holder — that is the recovery case', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi
        .fn()
        .mockResolvedValue(holdersFixture('lost', [holder({ live: false })])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, ownerId: 'su-new-holder' });
    expect(launch).toHaveBeenCalledOnce();
  });
});

describe('startGoalById — the readiness gate (activation, never dispatch)', () => {
  it('refuses an unready goal without startBlocked, launching nothing', async () => {
    const { deps, launch } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(res.ok === false && res.detail).toContain('plan:papercusp/some-prereq');
    expect(launch).not.toHaveBeenCalled();
  });

  it('startBlocked overrides, recording the audit trail', async () => {
    const { deps, launch } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps, {
      input: { startBlocked: true, startBlockedReason: 'owner said start anyway' },
    });
    expect(res).toMatchObject({ ok: true, startBlockedOverride: 'owner said start anyway' });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('synthesizes the override reason when none is given', async () => {
    const { deps } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps, { input: { startBlocked: true } });
    expect(res.ok && res.startBlockedOverride).toContain('plan:papercusp/some-prereq');
  });

  it('a ready goal carries a null override', async () => {
    const { deps } = makeDeps();
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, startBlockedOverride: null });
  });
});

describe('startGoalById — launch then attach', () => {
  it('launches into the goal row harness and attaches the launched identity to THIS goal', async () => {
    const { deps, launch, attach } = makeDeps();
    const res = await run(deps, { input: { launcherOwnerId: 'trigger-binding-7' } });
    expect(res).toMatchObject({ ok: true, goalId: GOAL, ownerId: 'su-new-holder', warnings: ['w1'] });
    expect(launch).toHaveBeenCalledWith({
      workspaceId: WS,
      goalId: GOAL,
      harnessSlug: 'papercusp',
      launcherOwnerId: 'trigger-binding-7',
      deferSpawn: false,
      kickoffPrompt: null,
    });
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        goalId: GOAL,
        ownerId: 'su-new-holder',
        setBy: 'trigger-binding-7',
      }),
    );
  });

  it("defaults attribution to 'goal-start-by-id' and forwards deferSpawn", async () => {
    const { deps, launch, attach } = makeDeps();
    await run(deps, { input: { deferSpawn: true } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ deferSpawn: true, launcherOwnerId: null }));
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ setBy: 'goal-start-by-id' }));
  });

  it('threads kickoffPrompt to the launch door (P-017 package starts brief their holder)', async () => {
    const { deps, launch } = makeDeps();
    await run(deps, { input: { kickoffPrompt: 'GOAL brief: keep the queue drained' } });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ kickoffPrompt: 'GOAL brief: keep the queue drained' }),
    );
  });

  it('a launch failure propagates as a throw and nothing is attached', async () => {
    const { deps, attach } = makeDeps();
    (deps.launch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('budget refused'));
    await expect(run(deps)).rejects.toThrow('budget refused');
    expect(attach).not.toHaveBeenCalled();
  });

  it('an attach failure throws, NAMING the orphan identity', async () => {
    const { deps } = makeDeps({
      attach: vi.fn().mockResolvedValue({ ok: false, error: 'mode store down' }),
    });
    await expect(run(deps)).rejects.toThrow(/su-new-holder.*mode store down/s);
  });
});
