/**
 * nudge-recipient — the Scout-rail recipient ladder (P-034,
 * retire-mug-kettle-su-only-2026-08-09).
 *
 * ⚠ WHY THIS FILE EXISTS AS A SEPARATE SUITE. The three Scout watchdog suites all went
 * GREEN the moment `deliverScoutNudge` was made additive (it still calls `wakeMug`, so
 * their existing `wakeMug` assertions keep passing) — while exercising NONE of the
 * routing added here. A green that survives because the new code never ran is not
 * evidence; these tests drive `resolveNudgeRecipient` directly through its DI seams so
 * each rung of the ladder is independently falsifiable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// P-037 seams. `deliverScoutNudge` reaches the REAL placement-watchdog (and so the
// REAL wakeMug) through a dynamic import, which is exactly what makes the composed
// contract testable here: stub only the two delivery legs and the flag, and the
// gate under test runs for real.
const { wakeRecipients, sendMessage, getFlag, listPresence, resolveSessionStates } = vi.hoisted(() => ({
  wakeRecipients: vi
    .fn()
    .mockResolvedValue({ targets: [], keys: [], woken: 0, staged: 0, stagedTargets: [], fanoutCapped: [] }),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  getFlag: vi.fn().mockResolvedValue(false),
  listPresence: vi.fn(),
  resolveSessionStates: vi.fn(),
}));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients }));
vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_ws: string, fn: () => unknown) => fn() }));
vi.mock('../agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPresence,
}));
vi.mock('../agent-tools/coordination/liveness-oracle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionStates,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag,
}));

import { resolveNudgeRecipient, deliverScoutNudge, shouldWakeSuRecipient, type NudgeRecipient } from './nudge-recipient';

const WS = 'papercusp-workspace';

/** A minimal presence row — only the fields the resolver reads. */
const row = (ownerId: string, extra: Record<string, unknown> = {}) =>
  ({
    ownerId,
    ownerLabel: `label:${ownerId}`,
    workspaceId: WS,
    source: 'claude',
    intent: '',
    currentPlanSlug: null,
    currentFiles: [],
    host: 'box',
    pid: 1,
    tty: null,
    startedAt: '2026-08-09T00:00:00.000Z',
    heartbeatAt: '2026-08-09T00:00:00.000Z',
    lastActiveAt: '2026-08-09T00:00:00.000Z',
    ...extra,
  }) as never;

const listing = (...rows: unknown[]) => vi.fn(async () => rows as never);
const states = (m: Record<string, string>) =>
  vi.fn(async () => new Map(Object.entries(m).map(([k, v]) => [k, { sessionState: v }])) as never);

/** P-037: rung 1 is conditional on the Mug tier still being runnable. Tests that
 *  assert the pre-retirement ladder say so explicitly rather than depending on
 *  whatever the ambient flag happens to resolve to. */
const tierOn = async () => true;
const tierOff = async () => false;

/** P-007 seam: the agent_modes read, as a fixture keyed by owner id. */
const modes = (m: Record<string, Array<{ mode: string; subject?: string | null }>>) =>
  vi.fn(async () => new Map(Object.entries(m)));
/** No modes for anyone — the pre-P-007 world, where rung 2 is pure recency. */
const noModes = vi.fn(async () => new Map());

describe('shouldWakeSuRecipient — the wake policy (WI-10004412)', () => {
  const su = (tier: 0 | 1 | 2): NudgeRecipient => ({ kind: 'su', ownerId: 'su-x', ownerLabel: 'x', why: '', tier });

  it("'grading-posture' wakes the steward (0) and a GRADE-mode su (1), never the recency fallback (2)", () => {
    expect(shouldWakeSuRecipient(su(0), 'grading-posture')).toBe(true);
    expect(shouldWakeSuRecipient(su(1), 'grading-posture')).toBe(true);
    expect(shouldWakeSuRecipient(su(2), 'grading-posture')).toBe(false);
  });

  it('a true pager wakes any su; an absent/false policy wakes none', () => {
    expect(shouldWakeSuRecipient(su(2), true)).toBe(true);
    expect(shouldWakeSuRecipient(su(0), false)).toBe(false);
    expect(shouldWakeSuRecipient(su(0), undefined)).toBe(false);
  });

  it('only an su verdict is ever woken by this leg', () => {
    expect(shouldWakeSuRecipient({ kind: 'escalate', why: '' }, true)).toBe(false);
    expect(shouldWakeSuRecipient({ kind: 'unresolved', why: '' }, 'grading-posture')).toBe(false);
    expect(shouldWakeSuRecipient({ kind: 'mug', ownerId: 'm', why: '' }, true)).toBe(false);
  });
});

describe('resolveNudgeRecipient — the ladder', () => {
  it('rung 1: a live Mug wins, and no su is consulted', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'live', 'su-a': 'live' }),
      mugKettleSystemEnabledFn: tierOn,
    });
    expect(r.kind).toBe('mug');
  });

  /**
   * P-037 — the retirement closes rung 1, and it MUST, because `wakeMug` is
   * gated on the same predicate: a 'mug' verdict makes deliverScoutNudge
   * early-return on a delivery that already no-opped, losing the nudge between
   * two gates. A live-and-deliverable Mug is the ONLY case that can expose it,
   * so that is exactly the fixture here — identical to rung 1 above but for the
   * tier flag.
   */
  it('rung 1 CLOSES once the tier is retired: an otherwise-winning live Mug yields to a live su', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'live', 'su-a': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
    });
    expect(r.kind).toBe('su');
  });

  /**
   * P-007 (blender-su-grade-integration-2026-08-11, D-003). The CALIBRATION case for the
   * whole tier block: with no modes on anyone, rung 2 must still pick purely by recency.
   * Without this, the tier tests below could pass while the ordering was broken in a way
   * that merely happened to favour the fixture's first row.
   */
  it('P-007 rung 2 tier 2 (calibration): with no grading posture anywhere, the most recently ACTIVE su still wins', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-stale', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-fresh', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-stale': 'live', 'su-fresh': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: noModes,
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-fresh' });
    expect((r as { why: string }).why).toContain('most recently active');
  });

  it('P-007 rung 2 tier 1: a GRADE-mode su beats a more recently active peer with no grading posture', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-grader', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-busy', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-grader': 'live', 'su-busy': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({ 'su-grader': [{ mode: 'grade' }] }),
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-grader' });
    expect((r as { why: string }).why).toContain('GRADE-mode');
  });

  /**
   * The steward shape D-003 mandates: GOAL mode owning the Blender loop with GRADE
   * stacked. It must outrank a bare grade-mode peer, or a Scout nudge lands on an su
   * grading some unrelated rubric while the loop's actual owner sits idle.
   */
  it('P-007 rung 2 tier 0: the GOAL-bound steward outranks a bare GRADE-mode su', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-steward', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-other-grader', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-steward': 'live', 'su-other-grader': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({
        'su-steward': [{ mode: 'grade' }, { mode: 'goal', subject: 'goal-blender-1' }],
        'su-other-grader': [{ mode: 'grade' }],
      }),
      readBlenderGoalIdsFn: async () => new Set(['goal-blender-1']),
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-steward' });
    expect((r as { why: string }).why).toContain('Blender steward');
  });

  /**
   * THE distinction the goal-agnostic predecessor could not make. Both candidates are
   * grade-mode AND goal-bound, so a bare `goalIdFromModes(modes) !== null` tiers them
   * IDENTICALLY and the more recently active one wins on recency — routing the Blender
   * loop's nudge to a session grading someone else's goal. Tier 0 must test the goal's
   * identity, so the steward wins here despite being the STALER of the two.
   */
  it('P-007 tier 0 is goal-SPECIFIC: a grader bound to an unrelated goal does not outrank the Blender steward', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-steward', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-other-goal', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-steward': 'live', 'su-other-goal': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({
        'su-steward': [{ mode: 'grade' }, { mode: 'goal', subject: 'goal-blender-1' }],
        'su-other-goal': [{ mode: 'grade' }, { mode: 'goal', subject: 'goal-something-else' }],
      }),
      readBlenderGoalIdsFn: async () => new Set(['goal-blender-1']),
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-steward' });
    expect((r as { why: string }).why).toContain('Blender steward');
  });

  /**
   * FAIL-SOFT for the goal read, and the reason it is safe to add a second query to this
   * path: an unresolvable goal set makes tier 0 merely UNREACHABLE, not wrong. The
   * grade-mode preference still holds (the grader beats the fresher non-grader) — the
   * nudge degrades by exactly one rung rather than falling all the way to recency.
   */
  it('P-007: an unreadable goals table degrades tier 0 to the GRADE-mode preference, not to recency', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-steward', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-busy', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-steward': 'live', 'su-busy': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({
        'su-steward': [{ mode: 'grade' }, { mode: 'goal', subject: 'goal-blender-1' }],
        'su-busy': [],
      }),
      readBlenderGoalIdsFn: async () => {
        throw new Error('goals unreadable');
      },
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-steward' });
    expect((r as { why: string }).why).toContain('GRADE-mode');
  });

  /**
   * The goal query is SKIPPED when no candidate could reach tier 0 anyway. Asserted
   * because it is a COST claim about the common path (nobody grading), and a cost claim
   * nothing falsifies is the kind that quietly stops being true.
   */
  it('P-007: the goal read is skipped entirely when no candidate is a goal-bound grader', async () => {
    let goalReads = 0;
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-stale', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-fresh', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-stale': 'live', 'su-fresh': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({ 'su-fresh': [{ mode: 'grade' }] }),
      readBlenderGoalIdsFn: async () => {
        goalReads += 1;
        return new Set<string>();
      },
    });
    expect(goalReads).toBe(0);
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-fresh' });
  });

  /**
   * A GOAL-mode row with a NULL subject is a session that entered GOAL mode but has not
   * filed its goal yet (goal-session.ts documents this as the only state that has ever
   * actually existed live). It is not a steward, so it must not be promoted over a real
   * grader — the same asymmetry `goalIdFromModes` encodes, asserted at THIS call site.
   */
  it('P-007: GOAL mode with no subject is NOT a steward — it does not outrank a grade-mode su', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-goal-unfiled', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
        row('su-grader', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-goal-unfiled': 'live', 'su-grader': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: modes({
        'su-goal-unfiled': [{ mode: 'goal', subject: null }],
        'su-grader': [{ mode: 'grade' }],
      }),
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-grader' });
  });

  /**
   * FAIL-SOFT, the property that keeps P-007 from being a new way to lose a nudge: an
   * unreadable agent_modes table must degrade rung 2 to its prior recency behaviour,
   * never throw and never drop the delivery.
   */
  it('P-007: an unreadable mode table degrades to recency instead of failing the nudge', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-stale', { lastActiveAt: '2026-08-09T00:00:00.000Z' }),
        row('su-fresh', { lastActiveAt: '2026-08-09T09:00:00.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-stale': 'live', 'su-fresh': 'live' }),
      mugKettleSystemEnabledFn: tierOff,
      readAgentModesFn: async () => {
        throw new Error('agent_modes unreadable');
      },
    });
    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-fresh' });
  });

  it('rung 1 FAILS CLOSED: an unreadable tier flag routes to the su, never to the Mug', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'live', 'su-a': 'live' }),
      mugKettleSystemEnabledFn: async () => {
        throw new Error('flag backend unreachable');
      },
    });
    expect(r.kind).toBe('su');
  });

  it('rung 2: an ENDED Mug falls through to a live su', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'ended', 'su-a': 'live' }),
    });
    expect(r.kind).toBe('su');
    expect(r.kind === 'su' && r.ownerId).toBe('su-a');
  });

  it('rung 2: with no Mug at all, a parked su is still deliverable', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'su-a': 'parked' }),
    });
    expect(r.kind).toBe('su');
  });

  it('rung 2: picks the most recently ACTIVE su, not the freshest heartbeat', async () => {
    // The keepalive bumps heartbeatAt on a session doing nothing, so ordering by it would
    // hand the nudge to the idlest agent. su-old has the NEWER heartbeat and OLDER activity.
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(
        row('su-old', { lastActiveAt: '2026-08-09T01:00:00.000Z', heartbeatAt: '2026-08-09T09:00:00.000Z' }),
        row('su-new', { lastActiveAt: '2026-08-09T08:00:00.000Z', heartbeatAt: '2026-08-09T08:00:01.000Z' }),
      ),
      resolveSessionStatesFn: states({ 'su-old': 'live', 'su-new': 'live' }),
    });
    expect(r.kind === 'su' && r.ownerId).toBe('su-new');
  });

  it('rung 3: escalates when presence reads fine but nobody is deliverable', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'ended', 'su-a': 'ended' }),
    });
    expect(r.kind).toBe('escalate');
  });

  it('rung 3: escalates when the workspace has no Mug and no su at all', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(),
      resolveSessionStatesFn: states({}),
    });
    expect(r.kind).toBe('escalate');
  });

  it('an UNJUDGED subject is not deliverable — unknown never collapses to alive', async () => {
    // The oracle returns NO entry for a subject whose wakeability fetch degraded. Treating
    // that as live would park the nudge on a session nobody confirmed is taking turns —
    // the same silent dead-end this module exists to remove.
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({}), // nothing judged
    });
    expect(r.kind).toBe('escalate');
  });

  describe('unresolved vs escalate — absence of evidence is not evidence of absence', () => {
    it('a presence-read failure is UNRESOLVED, never escalate', async () => {
      const r = await resolveNudgeRecipient({
        workspaceId: WS,
        mugOwner: 'mug-1',
        listPresenceFn: vi.fn(async () => {
          throw new Error('pg down');
        }) as never,
        resolveSessionStatesFn: states({}),
      });
      expect(r.kind).toBe('unresolved');
      expect(r.why).toMatch(/presence unreadable/);
    });

    it('an oracle failure is UNRESOLVED, never escalate', async () => {
      const r = await resolveNudgeRecipient({
        workspaceId: WS,
        mugOwner: 'mug-1',
        listPresenceFn: listing(row('su-a')),
        resolveSessionStatesFn: vi.fn(async () => {
          throw new Error('oracle down');
        }) as never,
      });
      expect(r.kind).toBe('unresolved');
    });
  });

  it('only su-prefixed owners are considered — an arbitrary live peer is not a reviewer', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: null,
      listPresenceFn: listing(row('cup-7'), row('release-fixer-2')),
      resolveSessionStatesFn: states({ 'cup-7': 'live', 'release-fixer-2': 'live' }),
    });
    expect(r.kind).toBe('escalate');
  });
});

/**
 * P-037 — the COMPOSED contract at the seam every Scout watchdog shares.
 *
 * The three watchdog suites cannot show this: they mock `../pot/placement-watchdog`
 * wholesale, so a gate INSIDE `wakeMug` is invisible to them and their green would
 * survive its removal. This block lets the REAL `wakeMug` run and stubs only its two
 * delivery legs, so these assertions fail if either gate is removed.
 *
 * The fixture is deliberately the WORST case — a Mug that is live and deliverable —
 * because that is the only state that can expose the loss bug the second gate exists
 * to prevent: a `kind:'mug'` verdict makes `deliverScoutNudge` early-return ("a
 * deliverable Mug needs no second recipient") on a delivery that has already no-opped.
 */
describe('deliverScoutNudge — the retirement gate, end to end (P-037)', () => {
  const toOf = (c: unknown[]): string[] => ((c[1] as { to?: string[] })?.to ?? []);

  beforeEach(() => {
    wakeRecipients.mockClear();
    sendMessage.mockClear();
    // No `as never` needed: `row()` already yields the resolver's own row type, and
    // these are bare vi.fn() seams. Casting here would defeat the one check the mock
    // gives us — that the fixture still matches the real signature.
    listPresence.mockResolvedValue([row('su-a')]);
    resolveSessionStates.mockResolvedValue(
      new Map([
        ['mug-1', { sessionState: 'live' }],
        ['su-a', { sessionState: 'live' }],
      ]),
    );
  });

  it('retired: NO Mug wake, NO @role:mug park — and the nudge still reaches the live su', async () => {
    getFlag.mockResolvedValue(false);
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: 'mug-1',
      summary: 'Scout-draft review backstop: 3 drafts unreviewed',
      source: 'scout-draft-review',
    });

    // The Mug rung is closed even though the Mug is live and deliverable.
    expect(r.kind).toBe('su');
    // wakeMug's direct leg never fires...
    expect(wakeRecipients).not.toHaveBeenCalled();
    // ...and nothing is parked into the slot only a Mug drains.
    expect(sendMessage.mock.calls.filter((c) => toOf(c).includes('@role:mug'))).toHaveLength(0);
    // The nudge is NOT lost between the two gates: it reaches the live su.
    expect(sendMessage.mock.calls.filter((c) => toOf(c).includes('su-a'))).toHaveLength(1);
  });

  it('a true pager persists the su message before explicitly waking that recipient', async () => {
    getFlag.mockResolvedValue(false);
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: null,
      summary: 'Scout cycle ERROR STREAK',
      source: 'scout-error-streak-alarm',
      payload: { kind: 'scout-error-streak' },
      wakeSu: true,
    });

    expect(r.kind).toBe('su');
    expect(sendMessage.mock.calls.filter((c) => toOf(c).includes('su-a'))).toHaveLength(1);
    expect(wakeRecipients).toHaveBeenCalledWith(
      ['su-a'],
      expect.objectContaining({
        summary: 'Scout cycle ERROR STREAK',
        source: 'scout-error-streak-alarm',
        workspaceId: WS,
      }),
    );
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      wakeRecipients.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  // CALIBRATION — this used to run the identical fixture WITH THE TIER ON
  // (`getFlag.mockResolvedValue(true)`) and assert the Mug was woken, proving the
  // "not called" assertions above were not just measuring a dead function.
  //
  // P-068/D-098 makes that case unconstructible: `mugKettleSystemEnabled()` is now
  // a permanent `false` and never consults `getFlag` at all, so mocking the flag
  // true changes nothing and the old assertion could only ever fail. (That is the
  // exact red WI-38231 reported — the test was unsatisfiable by construction, not
  // broken.)
  //
  // The vacuity risk is unchanged, so this is REPLACED rather than deleted: the
  // positive control now runs on the surviving su rung. Both spies the assertions
  // above depend on must demonstrably FIRE here, or a `not.toHaveBeenCalled()`
  // up there would be silence rather than evidence.
  /**
   * WI-10004412 — the grading backstop delivered inject-only to a different
   * recency-fallback su on every fire, so nothing ever started a turn. The policy wakes
   * ONLY a recipient whose posture is grading; the fallback is told it is an FYI.
   * The two cases below share one fixture and differ only in the recipient's modes, so
   * each is the other's calibration: a policy that never wakes fails the second, and
   * one that always wakes fails the first.
   */
  it("WI-10004412: 'grading-posture' does NOT wake a recency-fallback (tier 2) su, and says so", async () => {
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: null,
      summary: 'agent-review grading backstop',
      source: 'su-ideate-ungraded',
      wakeSu: 'grading-posture',
      recipientSeams: { readAgentModesFn: noModes },
    });

    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-a', tier: 2 });
    const sent = sendMessage.mock.calls.filter((c) => toOf(c).includes('su-a'));
    expect(sent).toHaveLength(1);
    expect((sent[0]?.[1] as { body: string }).body).toContain('un-woken FYI');
    expect(wakeRecipients).not.toHaveBeenCalled();
  });

  it("WI-10004412: 'grading-posture' WAKES a GRADE-mode (tier 1) su after the durable write", async () => {
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: null,
      summary: 'agent-review grading backstop',
      source: 'su-ideate-ungraded',
      wakeSu: 'grading-posture',
      recipientSeams: { readAgentModesFn: modes({ 'su-a': [{ mode: 'grade' }] }) },
    });

    expect(r).toMatchObject({ kind: 'su', ownerId: 'su-a', tier: 1 });
    const sent = sendMessage.mock.calls.filter((c) => toOf(c).includes('su-a'));
    expect(sent).toHaveLength(1);
    expect((sent[0]?.[1] as { body: string }).body).not.toContain('un-woken FYI');
    expect(wakeRecipients).toHaveBeenCalledWith(['su-a'], expect.objectContaining({ source: 'su-ideate-ungraded' }));
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      wakeRecipients.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('CALIBRATION: the identical call still delivers — via the su rung, on the same spies', async () => {
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: 'mug-1',
      summary: 'Scout-draft review backstop: 3 drafts unreviewed',
      source: 'scout-draft-review',
      wakeSu: true,
    });

    expect(r.kind).toBe('su');
    expect(sendMessage.mock.calls.filter((c) => toOf(c).includes('su-a'))).toHaveLength(1);
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
  });
});
