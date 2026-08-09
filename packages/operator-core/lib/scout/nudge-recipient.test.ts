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

import { describe, it, expect, vi } from 'vitest';
import { resolveNudgeRecipient } from './nudge-recipient';

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

describe('resolveNudgeRecipient — the ladder', () => {
  it('rung 1: a live Mug wins, and no su is consulted', async () => {
    const r = await resolveNudgeRecipient({
      workspaceId: WS,
      mugOwner: 'mug-1',
      listPresenceFn: listing(row('su-a')),
      resolveSessionStatesFn: states({ 'mug-1': 'live', 'su-a': 'live' }),
    });
    expect(r.kind).toBe('mug');
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
