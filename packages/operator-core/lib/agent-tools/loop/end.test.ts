/**
 * loop:end — the P-002 wind-down disposition gate (goal-mode-design-intent-
 * hardening-2026-08-16).
 *
 * The acceptance criterion, verbatim from the plan item: loop:end WITHOUT a
 * disposition on a still-active goal REFUSES, naming the missing arg and the
 * three legal values — and the refusal happens BEFORE deactivateLoop, so a
 * refused loop keeps firing. With a disposition, the loop ends, the goal row is
 * stamped, and the owner report (carry-note + reason folded in) is delivered.
 *
 * The gate's IO legs are mocked; the refusal/report BUILDERS run real
 * (importOriginal spread), so the wording asserted here is the wording the
 * production refusal actually carries.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/end.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
}));
vi.mock('../../harness/routines/loop', () => ({
  deactivateLoop: vi.fn(async () => true),
  getLoopStatus: vi.fn(async () => ({ harnessSlug: 'papercusp', ownerId: 'su-caller-own-id', active: true })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));
vi.mock('../coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: vi.fn(async () => ({ generation: 8 })),
}));
vi.mock('../orders/open-directives-guard', () => ({
  checkOpenDirectivesGuard: vi.fn(async () => null),
}));
vi.mock('../../carry-note', () => ({ getLoopCarryNote: vi.fn(async () => null) }));
// Keep the module graph light: these are transitive imports of the REAL
// wind-down-disposition module loaded via importOriginal below.
vi.mock('../../modes/store', () => ({ getModeSubject: vi.fn() }));
vi.mock('../coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('../../goals/wind-down-disposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../goals/wind-down-disposition')>();
  return {
    ...real,
    activeGoalForOwner: vi.fn(async () => null),
    applyGoalDisposition: vi.fn(async () => {}),
    deliverGoalWindDownReport: vi.fn(async () => {}),
    windDownDispositionGateEnabled: vi.fn(async () => true),
  };
});

import { deactivateLoop, getLoopStatus } from '../../harness/routines/loop';
import { getLoopCarryNote } from '../../carry-note';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
} from '../../goals/wind-down-disposition';
import endTool from './end';

const deactivateLoopMock = deactivateLoop as unknown as ReturnType<typeof vi.fn>;
const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
const getLoopCarryNoteMock = getLoopCarryNote as unknown as ReturnType<typeof vi.fn>;
const activeGoalForOwnerMock = activeGoalForOwner as unknown as ReturnType<typeof vi.fn>;
const applyGoalDispositionMock = applyGoalDisposition as unknown as ReturnType<typeof vi.fn>;
const deliverReportMock = deliverGoalWindDownReport as unknown as ReturnType<typeof vi.fn>;
const gateEnabledMock = windDownDispositionGateEnabled as unknown as ReturnType<typeof vi.fn>;

const ACTIVE_GOAL = {
  goalId: 'ship-paid-app-3f9a1c',
  title: 'Ship the paid app',
  installSlug: 'papercusp',
  recordedDisposition: null,
};

const run = (args: Record<string, unknown> = {}) =>
  (endTool as unknown as {
    handler: (
      a: unknown,
      ctx: unknown,
    ) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>;
  })
    .handler(args, {})
    .then((r) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true }));

beforeEach(() => {
  deactivateLoopMock.mockClear();
  deactivateLoopMock.mockResolvedValue(true);
  getLoopStatusMock.mockClear();
  getLoopStatusMock.mockResolvedValue({
    harnessSlug: 'papercusp',
    ownerId: 'su-caller-own-id',
    active: true,
  });
  getLoopCarryNoteMock.mockClear();
  getLoopCarryNoteMock.mockResolvedValue(null);
  activeGoalForOwnerMock.mockReset();
  activeGoalForOwnerMock.mockResolvedValue(null);
  applyGoalDispositionMock.mockReset();
  applyGoalDispositionMock.mockResolvedValue(undefined);
  deliverReportMock.mockReset();
  deliverReportMock.mockResolvedValue(undefined);
  gateEnabledMock.mockReset();
  gateEnabledMock.mockResolvedValue(true);
});

describe('the P-002 disposition gate (acceptance)', () => {
  it('REFUSES a goal-mode wind-down without a disposition — naming the arg and all three values — and does NOT end the loop', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/\bdisposition\b/);
    for (const d of GOAL_DISPOSITIONS) expect(got.error).toContain(`'${d}'`);
    expect(got.goalId).toBe(ACTIVE_GOAL.goalId);
    // The refusal must land BEFORE deactivation: a refused loop keeps firing.
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('with a disposition: ends the loop, stamps the goal, and delivers the owner report with reason + carry-note folded in', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    getLoopCarryNoteMock.mockResolvedValue('## Did\nplatform evidence lives here');
    const got = await run({ disposition: 'achieved', reason: 'all items shipped' });
    expect(got.isError).toBe(false);
    expect(got.ok).toBe(true);
    expect(got.ended).toBe(true);
    expect(got.disposition).toBe('achieved');
    expect(got.dispositionApplied).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        goalId: ACTIVE_GOAL.goalId,
        disposition: 'achieved',
        dispositionBy: 'su-caller-own-id',
      }),
    );
    // The report carries the evidence the agent already wrote.
    expect(deliverReportMock).toHaveBeenCalledTimes(1);
    const [, delivered] = deliverReportMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(delivered.body)).toContain('all items shipped');
    expect(String(delivered.body)).toContain('platform evidence lives here');
    // The carry-note was read via the harness the routine row named.
    expect(getLoopCarryNoteMock).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-caller-own-id',
    });
  });

  it('handoff flows through to the stamp and the report', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({ disposition: 'handoff', handoffTo: 'su-next' });
    expect(got.ok).toBe(true);
    expect(applyGoalDispositionMock).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'handoff', handoffTo: 'su-next' }),
    );
    const [, delivered] = deliverReportMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(String(delivered.summary)).toContain('su-next');
  });

  it('a non-goal owner is unaffected — plain end, no goal reads beyond the gate probe', async () => {
    const got = await run({ reason: 'done here' });
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
    expect(deliverReportMock).not.toHaveBeenCalled();
  });

  it('flag OFF disables the gate entirely: a goal owner without a disposition still stops', async () => {
    gateEnabledMock.mockResolvedValue(false);
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    // Gate off means the goal is never even consulted.
    expect(activeGoalForOwnerMock).not.toHaveBeenCalled();
  });

  it('an already-recorded disposition passes the gate without re-demanding it', async () => {
    activeGoalForOwnerMock.mockResolvedValue({ ...ACTIVE_GOAL, recordedDisposition: 'handoff' });
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });

  it('FAIL-SOFT: a report failure downgrades to a warning — the loop stays ended', async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    applyGoalDispositionMock.mockRejectedValue(new Error('goals table unreachable'));
    const got = await run({ disposition: 'killed' });
    expect(got.isError).toBe(false);
    expect(got.ok).toBe(true);
    expect(got.ended).toBe(true);
    expect(got.dispositionApplied).toBe(false);
    expect(String(got.warning)).toMatch(/goals:update/);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('a goal-resolution error passes the gate (positive-finding-only), never wedging the stop', async () => {
    activeGoalForOwnerMock.mockRejectedValue(new Error('pg down'));
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });
});

describe('argument schema', () => {
  it('accepts the three dispositions and rejects anything else', () => {
    const schema = (endTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } })
      .args;
    for (const d of GOAL_DISPOSITIONS)
      expect(schema.safeParse({ disposition: d }).success).toBe(true);
    expect(schema.safeParse({ disposition: 'paused' }).success).toBe(false);
    expect(schema.safeParse({ disposition: 'handoff', handoffTo: 'su-next' }).success).toBe(true);
  });
});
