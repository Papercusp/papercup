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

import { resolveNudgeRecipient, deliverScoutNudge } from './nudge-recipient';

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

  // CALIBRATION — the identical fixture while the tier runs. Without it these
  // assertions would also pass if deliverScoutNudge had simply stopped doing anything.
  it('CALIBRATION: while the tier runs, the identical call DOES wake the Mug and park the slot', async () => {
    getFlag.mockResolvedValue(true);
    const r = await deliverScoutNudge({
      workspaceId: WS,
      mugOwner: 'mug-1',
      summary: 'Scout-draft review backstop: 3 drafts unreviewed',
      source: 'scout-draft-review',
    });

    expect(r.kind).toBe('mug');
    expect(wakeRecipients).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.filter((c) => toOf(c).includes('@role:mug'))).toHaveLength(1);
  });
});
