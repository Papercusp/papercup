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
// EI-21349668185386229: the surviving-awaits read. Mocked (the real one queries
// PG); the KEY PREFIX stays the real constant's value so the filter under test
// is the production filter.
vi.mock('../../events/await/store', () => ({
  listActiveAwaits: vi.fn(async () => []),
  listParkedAwaitsForSubscribers: vi.fn(async () => []),
  INBOX_WAKE_KEY_PREFIX: 'coord:inbox-wake:',
}));
// Keep the module graph light: these are transitive imports of the REAL
// wind-down-disposition module loaded via importOriginal below.
vi.mock('../../modes/store', () => ({
  getModeSubject: vi.fn(),
  getModes: vi.fn(async () => []),
}));
vi.mock('../coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({})) }));
vi.mock('../../goals/wind-down-disposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../goals/wind-down-disposition')>();
  return {
    ...real,
    activeGoalForOwner: vi.fn(async () => null),
    applyGoalDisposition: vi.fn(async () => {}),
    deliverGoalWindDownReport: vi.fn(async () => {}),
    windDownDispositionGateEnabled: vi.fn(async () => true),
    // P-009 acceptance gate (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2).
    // MUST be mocked: the real one resolves its deps via `await import('../rubrics')` /
    // `('../scorecards')` and queries Postgres. Left real, this unit test's verdict flips
    // with PG REACHABILITY — the gate is positive-finding-only (`catch → satisfied:true`),
    // so it PASSES on a box with no PG and REFUSES on one with PG, where the fake goal
    // naturally has no acceptance rubric. That is what made this file "fail repeatedly"
    // (EI-20714629197442202) while reading green wherever PG was down. The gate's own
    // behavior is covered by its own tests; here we assert only that loop:end CONSULTS it
    // and honors BOTH verdicts.
    evaluateGoalAcceptanceGate: vi.fn(async () => ({ satisfied: true })),
  };
});

import { deactivateLoop, getLoopStatus } from '../../harness/routines/loop';
import { getLoopCarryNote } from '../../carry-note';
import { listActiveAwaits, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { getModes } from '../../modes/store';
import {
  GOAL_DISPOSITIONS,
  activeGoalForOwner,
  applyGoalDisposition,
  deliverGoalWindDownReport,
  windDownDispositionGateEnabled,
  evaluateGoalAcceptanceGate,
} from '../../goals/wind-down-disposition';
import endTool, { survivingAwaitsNote } from './end';

const deactivateLoopMock = deactivateLoop as unknown as ReturnType<typeof vi.fn>;
const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
const getLoopCarryNoteMock = getLoopCarryNote as unknown as ReturnType<typeof vi.fn>;
const activeGoalForOwnerMock = activeGoalForOwner as unknown as ReturnType<typeof vi.fn>;
const applyGoalDispositionMock = applyGoalDisposition as unknown as ReturnType<typeof vi.fn>;
const deliverReportMock = deliverGoalWindDownReport as unknown as ReturnType<typeof vi.fn>;
const gateEnabledMock = windDownDispositionGateEnabled as unknown as ReturnType<typeof vi.fn>;
const acceptanceGateMock = evaluateGoalAcceptanceGate as unknown as ReturnType<typeof vi.fn>;
const listActiveAwaitsMock = listActiveAwaits as unknown as ReturnType<typeof vi.fn>;
const listParkedAwaitsMock = listParkedAwaitsForSubscribers as unknown as ReturnType<typeof vi.fn>;
const getModesMock = getModes as unknown as ReturnType<typeof vi.fn>;

const ACTIVE_GOAL = {
  goalId: 'ship-paid-app-3f9a1c',
  title: 'Ship the paid app',
  installSlug: 'papercusp',
  recordedDisposition: null,
};

const run = (args: Record<string, unknown> = {}) =>
  (
    endTool as unknown as {
      handler: (a: unknown, ctx: unknown) => Promise<{ content: [{ type: 'text'; text: string }]; isError?: boolean }>;
    }
  )
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
  acceptanceGateMock.mockReset();
  acceptanceGateMock.mockResolvedValue({ satisfied: true });
  listActiveAwaitsMock.mockReset();
  listActiveAwaitsMock.mockResolvedValue([]);
  listParkedAwaitsMock.mockReset();
  listParkedAwaitsMock.mockResolvedValue([]);
  getModesMock.mockReset();
  getModesMock.mockResolvedValue([]);
});

describe('the P-012 wake-less autonomy guard', () => {
  const mode = (id: string) => ({ mode: id });
  const parkedAwait = {
    subscriberId: 'su-caller-own-id',
    eventKey: 'release:green',
    note: 'resume when green',
    expiresTs: null,
    createdAt: '2026-08-25T00:00:00.000Z',
    rootId: null,
  };

  it('refuses BEFORE deactivation when AUTO remains active and no deliberate event park survives', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);

    const got = await run({ reason: 'done for now' });

    expect(got).toMatchObject({
      isError: true,
      ok: false,
      error: 'wake_less_autonomy_refused',
      ownerId: 'su-caller-own-id',
      autonomyModes: ['auto'],
      requiredAcknowledgement: 'acknowledgeWakeLessAutonomy',
    });
    expect(String(got.message)).toContain('events:await');
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('derives autonomous overlays from the registry and checks the TARGET owner, not only the caller', async () => {
    getModesMock.mockResolvedValue([mode('drain')]);

    const got = await run({ ownerId: 'su-target', reason: 'leader wind-down' });

    expect(got).toMatchObject({
      isError: true,
      error: 'wake_less_autonomy_refused',
      ownerId: 'su-target',
      autonomyModes: ['drain'],
    });
    expect(getModesMock).toHaveBeenCalledWith('ws-1', 'su-target');
    expect(listParkedAwaitsMock).toHaveBeenCalledWith(['su-target']);
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('preserves an event-backed AUTO ending when a deliberate parked await survives', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    listParkedAwaitsMock.mockResolvedValue([parkedAwait]);

    const got = await run({ reason: 'parked on release' });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a platform-armed claim-release interest for a deliberate event park', async () => {
    getModesMock.mockResolvedValue([mode('auto')]);
    // listActiveAwaits is the broad receipt read and can see this platform
    // interest. The guard deliberately uses listParkedAwaitsForSubscribers,
    // whose store predicate excludes bound_to.kind=work-item-claim.
    listActiveAwaitsMock.mockResolvedValue([{ id: 87786, eventKey: 'claim:released:WI-41467', expiresTs: null }]);

    const got = await run({});

    expect(got.error).toBe('wake_less_autonomy_refused');
    expect(listActiveAwaitsMock).not.toHaveBeenCalled();
    expect(deactivateLoopMock).not.toHaveBeenCalled();
  });

  it('allows a conscious wake-less ending with the explicit acknowledgement', async () => {
    getModesMock.mockResolvedValue([mode('cold-auto')]);

    const got = await run({ acknowledgeWakeLessAutonomy: true });

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(deactivateLoopMock).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary non-autonomous endings unchanged', async () => {
    getModesMock.mockResolvedValue([mode('ideate')]);

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });

  it('leaves an already-inactive autonomous loop as the ordinary no-op instead of demanding an acknowledgement', async () => {
    getLoopStatusMock.mockResolvedValue({
      harnessSlug: 'papercusp',
      ownerId: 'su-caller-own-id',
      active: false,
    });
    deactivateLoopMock.mockResolvedValue(false);
    getModesMock.mockResolvedValue([mode('auto')]);

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(false);
    expect(String(got.note)).toMatch(/No active loop found/);
    expect(getModesMock).not.toHaveBeenCalled();
  });

  it('fails open when the classification read is unavailable, preserving the always-stoppable contract', async () => {
    getModesMock.mockRejectedValue(new Error('pg down'));

    const got = await run({});

    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
  });
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

  // P-009 (consult-min-max-and-rubric-vetting-2026-08-17 D-004 §2). These pin the SEAM,
  // not the gate's internals: that loop:end consults the acceptance gate for 'achieved'
  // ONLY, honors a refusal BEFORE deactivation, and does not consult it for the
  // dispositions that carry no acceptance claim.
  it("P-009: an UNSATISFIED acceptance gate refuses 'achieved' — and refuses BEFORE deactivation, so the loop keeps firing", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    acceptanceGateMock.mockResolvedValue({
      satisfied: false,
      code: 'goal_acceptance_rubric_missing',
      message: 'REFUSED — no acceptance rubric names this goal.',
      rubricId: undefined,
    });
    const got = await run({ disposition: 'achieved', reason: 'I say it is done' });
    expect(got.isError).toBe(true);
    expect(got.ok).toBe(false);
    expect(got.error).toBe('goal_acceptance_rubric_missing');
    expect(got.goalId).toBe(ACTIVE_GOAL.goalId);
    // The whole point of the ordering: a refused claim must not leave the loop stopped.
    expect(deactivateLoopMock).not.toHaveBeenCalled();
    expect(applyGoalDispositionMock).not.toHaveBeenCalled();
    expect(deliverReportMock).not.toHaveBeenCalled();
  });

  it("P-009: 'killed' and 'handoff' never consult the acceptance gate — they carry no acceptance claim", async () => {
    activeGoalForOwnerMock.mockResolvedValue(ACTIVE_GOAL);
    // Armed to REFUSE: if either disposition consulted it, the wind-down would fail here.
    acceptanceGateMock.mockResolvedValue({ satisfied: false, code: 'goal_acceptance_ungraded', message: 'x' });
    const killed = await run({ disposition: 'killed', reason: 'not worth finishing' });
    expect(killed.ok).toBe(true);
    expect(killed.ended).toBe(true);
    const handoff = await run({ disposition: 'handoff', handoffTo: 'su-peer', reason: 'passing it on' });
    expect(handoff.ok).toBe(true);
    expect(acceptanceGateMock).not.toHaveBeenCalled();
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
    const schema = (endTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    for (const d of GOAL_DISPOSITIONS) expect(schema.safeParse({ disposition: d }).success).toBe(true);
    expect(schema.safeParse({ disposition: 'paused' }).success).toBe(false);
    expect(schema.safeParse({ disposition: 'handoff', handoffTo: 'su-next' }).success).toBe(true);
    expect(schema.safeParse({ acknowledgeWakeLessAutonomy: true }).success).toBe(true);
    expect(schema.safeParse({ acknowledgeWakeLessAutonomy: 'yes' }).success).toBe(false);
  });
});

describe('the surviving-awaits receipt (EI-21349668185386229)', () => {
  // The disproven claim this fix retires. The new wordings ("no further LOOP
  // wakes") deliberately do not contain this substring, so the assertion
  // cannot pass by accident.
  const BLANKET_CLAIM = 'no further wakes will fire';

  it('with no surviving awaits: says so explicitly and never restates the blanket claim', async () => {
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toEqual([]);
    expect(String(got.note)).toMatch(/no independent event awaits remain/);
    expect(String(got.note)).not.toContain(BLANKET_CLAIM);
  });

  it('enumerates surviving awaits, filters the always-armed inbox-wake plumbing, and scopes the claim to LOOP wakes', async () => {
    listActiveAwaitsMock.mockResolvedValue([
      { id: 88515, eventKey: 'green-checkpoint:inconclusive', expiresTs: null },
      { id: 87786, eventKey: 'claim:released:EI-123', expiresTs: '2026-08-25T00:00:00Z' },
      // Liveness plumbing every live agent holds — must NOT render as a bench.
      { id: 90000, eventKey: 'coord:inbox-wake:su-caller-own-id', expiresTs: null },
    ]);
    const got = await run({});
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toEqual([
      { await_id: 88515, event_key: 'green-checkpoint:inconclusive', expires_ts: null },
      { await_id: 87786, event_key: 'claim:released:EI-123', expires_ts: '2026-08-25T00:00:00Z' },
    ]);
    const note = String(got.note);
    expect(note).toMatch(/no further LOOP wakes will fire/);
    expect(note).toMatch(/2 independent event await\(s\) remain active/);
    expect(note).toContain('#88515 green-checkpoint:inconclusive');
    expect(note).toMatch(/events:cancel \{ await_ids \}/);
    expect(note).not.toContain(BLANKET_CLAIM);
  });

  it('FAIL-SOFT: a read failure never blocks the stop — the note degrades to the scoped claim, survivingAwaits is omitted', async () => {
    listActiveAwaitsMock.mockRejectedValue(new Error('pg down'));
    const got = await run({});
    expect(got.isError).toBe(false);
    expect(got.ended).toBe(true);
    expect(got.survivingAwaits).toBeUndefined();
    expect(String(got.note)).toMatch(/no further LOOP wakes will fire/);
    expect(String(got.note)).toMatch(/events:status to inspect/);
    expect(String(got.note)).not.toContain(BLANKET_CLAIM);
  });

  it('a no-op end (no active loop) does not read awaits at all', async () => {
    deactivateLoopMock.mockResolvedValue(false);
    const got = await run({});
    expect(got.ended).toBe(false);
    expect(got.survivingAwaits).toBeUndefined();
    expect(listActiveAwaitsMock).not.toHaveBeenCalled();
  });

  it('survivingAwaitsNote caps the enumeration at 10 while the count stays exact', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      await_id: 1000 + i,
      event_key: `key-${i}`,
    }));
    const note = survivingAwaitsNote(rows);
    expect(note).toMatch(/12 independent event await\(s\)/);
    expect(note).toContain('#1009 key-9');
    expect(note).not.toContain('#1010 key-10');
    expect(note).toContain('+2 more');
  });
});
