import { describe, it, expect } from 'vitest';
import {
  deriveLiveness,
  scopePresenceToWorkspace,
  mergeRosterEntries,
  dedupeEndedAgainstActive,
  shouldProbePid,
  LIVE_MS,
  GLOBAL_WORKSPACE,
} from './adv-roster';
import { PRESENCE_STALE_MS, type PresenceRecord } from './agent-tools/coordination/presence';
import { STALE_MS } from './liveness';
import type { AdvSessionRow } from './adv-sessions';

it('liveness STALE_MS leaf mirrors coordination PRESENCE_STALE_MS (no drift)', () => {
  expect(STALE_MS).toBe(PRESENCE_STALE_MS);
});

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function presence(overrides: Partial<PresenceRecord> = {}): PresenceRecord {
  return {
    ownerId: 'su-1',
    ownerLabel: 'su · su-1',
    workspaceId: 'ws1',
    source: 'claude',
    intent: 'doing X',
    currentPlanSlug: null,
    currentFiles: [],
    host: 'h',
    pid: 100,
    startedAt: iso(NOW - 3_600_000),
    heartbeatAt: iso(NOW - 5_000),
    stale: false,
    userId: null,
    revoked: false,
    ...overrides,
  };
}

function adv(overrides: Partial<AdvSessionRow> = {}): AdvSessionRow {
  return {
    id: 1,
    workspaceId: 'ws1',
    planSlug: 'my-plan',
    agent: 'claude',
    role: 'worker',
    feature: 'F-001',
    mode: 'console',
    terminalBin: null,
    pid: 100,
    windowId: 'w-1',
    ompThreadId: null,
    label: 'worker · F-001',
    cwd: '/repo',
    coordOwnerId: 'su-1',
    sessionId: null,
    startedAt: iso(NOW - 3_600_000),
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

describe('deriveLiveness', () => {
  it('live when the heartbeat is younger than LIVE_MS', () => {
    expect(deriveLiveness(iso(NOW - 30_000), NOW)).toBe('live');
    expect(deriveLiveness(iso(NOW - (LIVE_MS - 1)), NOW)).toBe('live');
  });

  it('idle between LIVE_MS and PRESENCE_STALE_MS (boundary is idle)', () => {
    expect(deriveLiveness(iso(NOW - LIVE_MS), NOW)).toBe('idle'); // exactly LIVE_MS → not < → idle
    expect(deriveLiveness(iso(NOW - 300_000), NOW)).toBe('idle');
    expect(deriveLiveness(iso(NOW - (PRESENCE_STALE_MS - 1)), NOW)).toBe('idle');
  });

  it('stale at/after PRESENCE_STALE_MS', () => {
    expect(deriveLiveness(iso(NOW - PRESENCE_STALE_MS), NOW)).toBe('stale');
    expect(deriveLiveness(iso(NOW - 3_600_000), NOW)).toBe('stale');
  });
});

describe('scopePresenceToWorkspace', () => {
  const rows = [
    presence({ ownerId: 'a', workspaceId: 'ws1' }),
    presence({ ownerId: 'b', workspaceId: 'ws2' }),
    presence({ ownerId: 'c', workspaceId: GLOBAL_WORKSPACE }),
  ];

  it('includes the matching workspace AND the global (*) rows, excludes others', () => {
    const got = scopePresenceToWorkspace(rows, 'ws1').map((r) => r.ownerId);
    expect(got).toEqual(['a', 'c']); // ws1 + the '*' SU shell; ws2 dropped
  });

  it('null workspace = the All scope (every row)', () => {
    expect(scopePresenceToWorkspace(rows, null).map((r) => r.ownerId)).toEqual(['a', 'b', 'c']);
    expect(scopePresenceToWorkspace(rows, undefined)).toHaveLength(3);
  });
});

describe('mergeRosterEntries', () => {
  it('presence-only agent (no adv_sessions row) still appears, with null enrichment', () => {
    const [entry] = mergeRosterEntries([presence({ currentPlanSlug: 'live-plan' })], new Map(), NOW);
    expect(entry.hasLaunchRecord).toBe(false);
    expect(entry.advSessionId).toBeNull();
    expect(entry.role).toBeNull();
    expect(entry.feature).toBeNull();
    expect(entry.currentPlanSlug).toBe('live-plan'); // from presence
    expect(entry.liveness).toBe('live');
  });

  it('joins adv_sessions enrichment by owner id', () => {
    const advByOwner = new Map<string, AdvSessionRow>([['su-1', adv()]]);
    const [entry] = mergeRosterEntries([presence()], advByOwner, NOW);
    expect(entry.hasLaunchRecord).toBe(true);
    expect(entry.advSessionId).toBe(1);
    expect(entry.role).toBe('worker');
    expect(entry.feature).toBe('F-001');
    expect(entry.windowId).toBe('w-1');
    expect(entry.cwd).toBe('/repo');
  });

  it('currentPlanSlug prefers the live presence plan, falls back to the launch plan', () => {
    const advByOwner = new Map<string, AdvSessionRow>([['su-1', adv({ planSlug: 'launch-plan' })]]);
    // presence has no live plan → fall back to adv.planSlug
    const [fallback] = mergeRosterEntries([presence({ currentPlanSlug: null })], advByOwner, NOW);
    expect(fallback.currentPlanSlug).toBe('launch-plan');
    // presence has a live plan → it wins
    const [live] = mergeRosterEntries([presence({ currentPlanSlug: 'live-plan' })], advByOwner, NOW);
    expect(live.currentPlanSlug).toBe('live-plan');
  });

  it('preserves presence order (newest-heartbeat-first from listPresence)', () => {
    const got = mergeRosterEntries(
      [presence({ ownerId: 'x' }), presence({ ownerId: 'y' }), presence({ ownerId: 'z' })],
      new Map(),
      NOW,
    );
    expect(got.map((r) => r.ownerId)).toEqual(['x', 'y', 'z']);
  });

  it('attaches canonical claims from the fleet_assignment view by owner id (D-002)', () => {
    const claims = new Map([
      [
        'su-1',
        [
          {
            type: 'plan-item' as const,
            harnessSlug: 'all',
            planSlug: 'plan-x',
            id: 'P-001',
            itemKind: null,
            detail: 'building',
            status: null,
            acquiredTs: iso(NOW - 60_000),
            expiresTs: iso(NOW + 60_000),
            active: true,
            orphaned: false,
          },
        ],
      ],
    ]);
    const [withClaims, without] = mergeRosterEntries(
      [presence({ ownerId: 'su-1' }), presence({ ownerId: 'su-2' })],
      new Map(),
      NOW,
      claims,
    );
    expect(withClaims.claims).toHaveLength(1);
    expect(withClaims.claims[0].id).toBe('P-001');
    expect(without.claims).toEqual([]);
  });
});

describe('dedupeEndedAgainstActive', () => {
  it('drops ended rows whose coord owner is still live in the active roster', () => {
    const ended = [adv({ id: 1, coordOwnerId: 'su-live' }), adv({ id: 2, coordOwnerId: 'su-gone' })];
    const got = dedupeEndedAgainstActive(ended, [{ ownerId: 'su-live' }]);
    expect(got.map((r) => r.id)).toEqual([2]); // su-live shown in active; su-gone kept as ended
  });

  it('keeps ended rows with no coord_owner_id (console/legacy cannot collide)', () => {
    const ended = [adv({ id: 5, coordOwnerId: null })];
    expect(dedupeEndedAgainstActive(ended, [{ ownerId: 'su-x' }]).map((r) => r.id)).toEqual([5]);
  });

  it('keeps everything when nothing is active', () => {
    const ended = [adv({ id: 1, coordOwnerId: 'a' }), adv({ id: 2, coordOwnerId: 'b' })];
    expect(dedupeEndedAgainstActive(ended, []).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('shouldProbePid (zombie detection eligibility, P-008)', () => {
  const make = (over: Partial<PresenceRecord>) =>
    mergeRosterEntries([presence({ host: 'box1', pid: 42, ...over })], new Map(), NOW)[0];

  it('probes a same-host non-stale entry with a pid', () => {
    expect(shouldProbePid(make({}), 'box1')).toBe(true);
  });
  it('probes a host-less (empty host) entry — assumed local', () => {
    expect(shouldProbePid(make({ host: '' }), 'box1')).toBe(true);
  });
  it('skips a different host (can’t check, pid could collide)', () => {
    expect(shouldProbePid(make({}), 'other-box')).toBe(false);
  });
  it('skips an entry with no pid', () => {
    expect(shouldProbePid(make({ pid: null }), 'box1')).toBe(false);
  });
  it('skips a stale entry (already known-gone)', () => {
    const e = make({ heartbeatAt: iso(NOW - STALE_MS - 1) });
    expect(e.liveness).toBe('stale');
    expect(shouldProbePid(e, 'box1')).toBe(false);
  });
});
