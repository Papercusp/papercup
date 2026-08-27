import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MECHANICAL_CHECKPOINT_MARKER } from '../../turn-end-tracking';
import {
  classifyFleetAuditCheckpoint,
  decodeFleetAuditCursor,
  encodeFleetAuditCursor,
  pageFleetAuditMembers,
  projectFleetAuditCompletion,
  readFleetAudit,
  validateFleetAuditCursor,
  type FleetAuditCursor,
  type FleetAuditEvidenceReaders,
} from './fleet-audit';

const NOW = new Date('2026-08-27T09:00:00.000Z');
const SINCE = '2026-08-26T09:00:00.000Z';
const SQL = {} as Sql;

const cursor: FleetAuditCursor = {
  version: 1,
  fleet: 'fleet-a',
  workspace: 'workspace-a',
  harness: 'papercusp',
  sinceAt: SINCE,
  snapshotAt: NOW.toISOString(),
  afterOwnerId: 'su-b',
};

describe('fleet:audit cursor and bounded paging', () => {
  it('round-trips a snapshot/keyset cursor and rejects scope drift', () => {
    const encoded = encodeFleetAuditCursor(cursor);
    expect(decodeFleetAuditCursor(encoded)).toEqual(cursor);
    expect(() => validateFleetAuditCursor(decodeFleetAuditCursor(encoded), {
      fleet: 'fleet-a',
      workspace: 'workspace-a',
      harness: 'papercusp',
      sinceAt: SINCE,
    })).not.toThrow();
    expect(() => validateFleetAuditCursor(decodeFleetAuditCursor(encoded), {
      fleet: 'fleet-b',
      workspace: 'workspace-a',
      harness: 'papercusp',
    })).toThrow('fleet:audit cursor scope mismatch');
    expect(() => decodeFleetAuditCursor('not-a-cursor')).toThrow('invalid fleet:audit cursor');
  });

  it('deduplicates, sorts, and keyset-pages member ids', () => {
    expect(pageFleetAuditMembers(['su-c', 'su-a', 'su-b', 'su-b'], null, 2)).toEqual({
      rows: ['su-a', 'su-b'],
      hasMore: true,
    });
    expect(pageFleetAuditMembers(['su-c', 'su-a', 'su-b'], 'su-b', 2)).toEqual({
      rows: ['su-c'],
      hasMore: false,
    });
  });
});

describe('fleet:audit evidence semantics', () => {
  it('separates authored checkpoints from mechanical carry and no checkpoint', () => {
    expect(classifyFleetAuditCheckpoint(
      `Implemented the reader.\n${MECHANICAL_CHECKPOINT_MARKER}\nloop metadata`,
      NOW.getTime() - 1_000,
      NOW.getTime(),
    )).toMatchObject({
      kind: 'authored',
      ageMs: 1_000,
      excerpt: 'Implemented the reader.',
    });
    expect(classifyFleetAuditCheckpoint(
      `${MECHANICAL_CHECKPOINT_MARKER}\nloop metadata`,
      NOW.getTime(),
      NOW.getTime(),
    ).kind).toBe('mechanical');
    expect(classifyFleetAuditCheckpoint(null, null, NOW.getTime())).toEqual({
      kind: 'none',
      updatedAt: null,
      ageMs: null,
      excerpt: null,
    });
  });

  it('projects structured completion evidence and preserves completion authority', () => {
    expect(projectFleetAuditCompletion({
      owner_id: 'su-a',
      feature_id: 'WI-1',
      item_kind: 'change',
      title: 'Ship the audit',
      status: 'done',
      terminal_owner: 'su-a',
      terminal_completion_ref: 'completion:1',
      completion_evidence: {
        filesChanged: ['fleet-audit.ts'],
        testsRun: 'npm run test:file -- fleet-audit.test.ts',
        testResult: '8 passed',
        verifiedHow: 'unit',
        addedTests: true,
      },
      authority: 'committed',
      closed_ts: NOW.getTime(),
    } as never)).toMatchObject({
      ownerId: 'su-a',
      workItemId: 'WI-1',
      filesChanged: ['fleet-audit.ts'],
      testsRun: 'npm run test:file -- fleet-audit.test.ts',
      testResult: '8 passed',
      verifiedHow: 'unit',
      addedTests: true,
      completionAuthority: 'committed',
      countsTowardBurnDown: true,
      terminalizedAt: NOW.toISOString(),
    });

    expect(projectFleetAuditCompletion({
      owner_id: 'su-a',
      feature_id: 'WI-2',
      status: 'done',
      terminal_owner: 'su-a',
      completion_evidence: { filesChanged: [42] },
      authority: 'proposed',
      closed_ts: NOW.getTime(),
    } as never)).toMatchObject({
      filesChanged: null,
      completionAuthority: 'proposed',
      countsTowardBurnDown: false,
    });
  });
});

const readers = (): FleetAuditEvidenceReaders => ({
  membership: async (scope) => scope.ownerIds.map((ownerId, index) => ({
    ownerId,
    ownerLabel: `label-${ownerId}`,
    fleetRole: 'member',
    event: 'join',
    at: scope.snapshotAt,
    id: index + 1,
  })),
  sessions: async (scope) => scope.ownerIds.map((ownerId, index) => ({
    ownerId,
    id: index + 1,
    agent: 'su',
    role: 'su',
    sessionId: `session-${ownerId}`,
    planSlug: 'plan-a',
    harnessSlug: scope.harnessSlug,
    startedAt: scope.sinceAt,
    endedAt: null,
    endedBy: null,
    endedSignal: null,
    exitCode: null,
  })),
  currentClaims: async () => [],
  claimTransitions: async () => [],
  completions: async () => [],
});

const deps = (overrides: Record<string, unknown> = {}) => ({
  now: () => NOW,
  fleetRecord: async () => ({ createdAt: SINCE, lastLaunchTransaction: null }) as never,
  everMembers: async () => new Set(['su-c', 'su-a', 'su-b']),
  assignments: async () => [],
  reconcile: async (groups: unknown[]) => groups as never,
  unanswered: async () => new Map(),
  readers: readers(),
  ...overrides,
});

describe('readFleetAudit canonical composition', () => {
  it('freezes the snapshot across pages and identifies every canonical writer', async () => {
    const first = await readFleetAudit({
      fleet: 'fleet-a',
      workspace: 'workspace-a',
      harness: 'papercusp',
      since: SINCE,
      limit: 2,
    }, deps(), SQL);

    expect(first.page).toMatchObject({ shown: 2, totalEverMembers: 3, hasMore: true });
    expect(first.members.map((member) => member.ownerId)).toEqual(['su-a', 'su-b']);
    expect(first.members[0].membership).toMatchObject({
      writer: 'harness_shared.fleet_membership_events',
      available: true,
      coverage: 'bounded',
    });
    expect(first.members[0].sessions.writer).toBe('harness_shared.adv_sessions');
    expect(first.members[0].claims.current.writer).toContain('harness_shared.work_items.taken_by');
    expect(first.members[0].claims.transitions.writer).toContain('worked_by_history');
    expect(first.members[0].completions.writer).toContain('terminal_owner');
    expect(first.members[0].assignment.coverage).toBe('current');
    expect(first.members[0].liveness.coverage).toBe('current');
    expect(first.members[0].wakeability.coverage).toBe('current');
    expect(first.members[0].directedBacklog.writer).toContain('coord_event_log');

    const second = await readFleetAudit({
      fleet: 'fleet-a',
      workspace: 'workspace-a',
      harness: 'papercusp',
      cursor: first.page.nextCursor!,
      limit: 2,
    }, deps({ now: () => new Date('2026-08-28T09:00:00.000Z') }), SQL);

    expect(second.snapshotAt).toBe(first.snapshotAt);
    expect(second.sinceAt).toBe(first.sinceAt);
    expect(second.members.map((member) => member.ownerId)).toEqual(['su-c']);
    expect(second.page).toMatchObject({ shown: 1, totalEverMembers: 3, hasMore: false, nextCursor: null });
  });

  it('marks failed legs unknown without converting them to empty evidence', async () => {
    const failingReaders = readers();
    failingReaders.membership = async () => { throw new Error('membership unavailable'); };
    const result = await readFleetAudit({
      fleet: 'fleet-a',
      workspace: 'workspace-a',
      harness: 'papercusp',
      since: SINCE,
      limit: 1,
    }, deps({
      fleetRecord: async () => { throw new Error('fleet record unavailable'); },
      assignments: async () => { throw new Error('assignment unavailable'); },
      unanswered: async () => { throw new Error('directed backlog unavailable'); },
      readers: failingReaders,
    }), SQL);

    expect(result.degradedLegs).toEqual(expect.arrayContaining([
      'assignments',
      'wakeability',
      'directedBacklog',
      'bootStages',
      'membership',
    ]));
    expect(result.unknowns).toEqual(expect.arrayContaining([
      'assignments unavailable',
      'bootStages unavailable',
      'membership unavailable',
    ]));
    expect(result.members[0].membership).toMatchObject({
      available: false,
      coverage: 'unknown',
      data: null,
    });
    // The reason must still NAME the writer, but it must ALSO carry the underlying cause.
    // This assertion used to pin the exact string 'harness_shared.fleet_membership_events-read-failed',
    // which locked in a reason synthesized purely from the writer name and threw settled.reason away.
    // That is precisely how a plain Postgres 42703 ('column harness_slug does not exist') hid inside
    // the sessions reader and left that leg permanently degraded with no way to tell why. Pin the
    // property that matters — writer identity AND propagated cause — not the old lossy format.
    expect(result.members[0].membership.reason).toContain('harness_shared.fleet_membership_events-read-failed');
    expect(result.members[0].membership.reason).toContain('membership unavailable');
    expect(result.members[0].assignment).toMatchObject({ available: false, coverage: 'unknown' });
    expect(result.members[0].bootStages).toMatchObject({
      available: false,
      coverage: 'unknown',
      reason: 'fleet-record-read-failed',
    });
    expect(result.members[0].directedBacklog).toMatchObject({ available: false, coverage: 'unknown' });
  });
});
