/**
 * bench.test.ts — fleet-reliability-verification-2026-07-10 P-006.
 *
 * projectBenchRows is the PURE reshape (event_awaits rows → the bench
 * roster, bench-tagged rows only) — unit-tested directly (mirrors
 * leader-brief.test.ts's projectMember pattern). The handler is exercised
 * with mocked deps for: stage mode (registers FOR `member`, not the caller;
 * tags the note; reports a bench miss immediately when no wake handle is
 * found) and list mode (resolves the fleet, filters to bench-tagged rows).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-leader', ownerLabel: 'l', source: 'static-client', workspaceId: 'ws-x', userId: null }),
  deriveFleetMembership: vi.fn(() => ({ fleetSlug: 'p2p-git' })),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-x',
  resolveConcreteWorkspaceId: (...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && c.trim() !== '*') return c.trim();
    }
    return 'ws-x';
  },
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async (ownerId: string) =>
    ownerId === 'su-no-session'
      ? { handle: null, note: 'no tracked session for your coord id — the wake degrades to an inbox notification' }
      : { handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' },
  ),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({ id: 42, eventKey: i.eventKey, expiresTs: '2030-01-01' })),
  listParkedAwaitsForSubscribers: vi.fn(async () => []),
}));
vi.mock('../../fleet/assignments', () => ({
  listFleetAssignments: vi.fn(async () => []),
  groupByAgent: vi.fn((rows: unknown[]) => rows),
}));
// WI-5938: default to a DRAINED lane so every pre-existing stage-mode test keeps
// exercising the bench path it was written for; the refusal tests opt in per-case.
vi.mock('../../fleet/lane-health', () => ({
  readFleetLaneHealth: vi.fn(async () => ({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
    spec: {
      ref: 'spec-x (spec rev 3)',
      specId: 'spec-x',
      revision: 3,
      matchedBy: 'fleet-slug',
      harness: 'papercusp',
      assigneeScoped: null,
    },
  })),
}));

import benchTool, { projectBenchRows, benchQueueVerdict } from './bench';
import { registerAwait, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { listFleetAssignments, groupByAgent } from '../../fleet/assignments';
import { deriveFleetMembership } from '../coordination/identity';
import { readFleetLaneHealth } from '../../fleet/lane-health';

const lane = (claimable: number, matchedByFilter = claimable) => ({
  claimable,
  matchedByFilter,
  excluded: {},
  spec: {
    ref: 'spec-x (spec rev 3)',
    specId: 'spec-x',
    revision: 3,
    matchedBy: 'fleet-slug',
    harness: 'papercusp',
    assigneeScoped: null,
  },
});

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof benchTool.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await benchTool.handler(args as never, ctx)) as { data: Record<string, unknown> };
  return res.data;
};

beforeEach(() => vi.clearAllMocks());

describe('projectBenchRows (pure)', () => {
  const NOW = '2026-07-10T12:00:00.000Z';

  it('keeps only bench-tagged rows and restores the staged assignment from the note', () => {
    const rows = [
      { subscriberId: 'su-a', eventKey: 'k1', note: '[fleet:bench] flip TEST hive bridged', expiresTs: null, createdAt: NOW },
      { subscriberId: 'su-b', eventKey: 'k2', note: 'unrelated events:await note', expiresTs: null, createdAt: NOW },
      { subscriberId: 'su-c', eventKey: 'k3', note: null, expiresTs: null, createdAt: NOW },
    ];
    const out = projectBenchRows(rows);
    expect(out).toEqual([
      { member: 'su-a', event: 'k1', stagedAssignment: 'flip TEST hive bridged', benchedAt: NOW, expiresTs: null },
    ]);
  });

  it('a bench-tagged row with an empty staged assignment maps to null, never an empty string', () => {
    const rows = [{ subscriberId: 'su-a', eventKey: 'k1', note: '[fleet:bench] ', expiresTs: null, createdAt: NOW }];
    expect(projectBenchRows(rows)[0].stagedAssignment).toBeNull();
  });

  it('empty input → empty output', () => {
    expect(projectBenchRows([])).toEqual([]);
  });
});

describe('fleet:bench — stage mode', () => {
  it('registers the await FOR `member`, not the caller, tagging the note with the staged assignment', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: 'p2p-git:phase3-open', stagedAssignment: 'flip TEST hive bridged' });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-worker');
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-worker',
      eventKey: 'p2p-git:phase3-open',
      policy: 'wake',
      note: '[fleet:bench] flip TEST hive bridged',
      timeoutBehavior: 'wake',
    });
    expect(out).toMatchObject({
      ok: true,
      bench_id: 42,
      member: 'su-worker',
      event: 'p2p-git:phase3-open',
      stagedAssignment: 'flip TEST hive bridged',
      registered: true,
      benched_by: 'su-leader',
    });
  });

  it('reports a bench miss immediately when no wake handle is found for the member', async () => {
    const out = await call({ member: 'su-no-session', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, registered: false });
    expect(out.advice as string).toContain('BENCH MISS');
  });

  it('missing member/wakeEvent (and not list mode) errors instead of silently no-oping', async () => {
    const out = await call({ stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: false, error: 'missing_args' });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('a pattern wakeEvent is flagged pattern:true and expanded before registering', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: '@fleet:red-team', stagedAssignment: 'x' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('fleet:*:red-team');
    expect(out).toMatchObject({ pattern: true });
  });
});

describe('benchQueueVerdict (pure) — park/pull is derived state, not prose [WI-5938]', () => {
  it('claimable > 0 ⇒ REFUSE: the lane is live, so park is the wrong verb', () => {
    expect(benchQueueVerdict(lane(4))).toMatchObject({
      refuse: true,
      claimable: 4,
      reason: 'queue-nonempty',
      specRef: 'spec-x (spec rev 3)',
    });
  });

  it('a genuinely drained lane (0 claimable, 0 matching) still benches', () => {
    expect(benchQueueVerdict(lane(0, 0))).toMatchObject({ refuse: false, reason: 'drained' });
  });

  it('GATED is not drained but IS benchable: 0 claimable with rows still matching the filter', () => {
    // EI-18689489507862177 — the backlog exists, every row is behind a claim floor. That
    // is a BLOCKED lane, which is exactly what benching is for.
    expect(benchQueueVerdict(lane(0, 113))).toMatchObject({ refuse: false, reason: 'gated' });
  });

  it('an UNREADABLE count fails OPEN as unknown — never refuses, and never reports "drained"', () => {
    // A read error must not wedge every bench on the fleet, and must not be laundered
    // into a verified-empty queue. Both halves matter.
    const v = benchQueueVerdict(null);
    expect(v).toMatchObject({ refuse: false, reason: 'unknown', claimable: null });
    expect(v.reason).not.toBe('drained');
  });
});

describe('fleet:bench — stage mode refuses a live lane [WI-5938 acceptance]', () => {
  it('ACCEPTANCE: a member with claimable > 0 gets the typed refusal, and NOTHING is staged', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(7));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({
      ok: false,
      error: 'bench_refused_queue_nonempty',
      member: 'su-worker',
      claimable: 7,
      spec_ref: 'spec-x (spec rev 3)',
    });
    // The refusal must happen BEFORE staging — a refused bench that still registered an
    // await would park the member anyway while reporting that it had not.
    expect(registerAwait).not.toHaveBeenCalled();
    expect(captureWakeHandleForOwner).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: a genuinely drained lane still benches normally', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(0, 0));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, bench_id: 42, lane: { verdict: 'drained', claimable: 0 } });
    expect(registerAwait).toHaveBeenCalled();
  });

  it('scopes the claimable floors to the MEMBER being benched, not the calling leader', async () => {
    // Their own held claims must not count against them as an exclusion, or a member
    // holding work reads as a gated lane rather than a live one.
    await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(vi.mocked(readFleetLaneHealth).mock.calls[0][0]).toMatchObject({
      fleet: 'p2p-git',
      assignee: 'su-worker',
    });
  });

  it('{ force: true } benches past a live lane but reports the override rather than hiding it', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(7));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x', force: true });
    expect(out).toMatchObject({ ok: true, forced: true, lane: { verdict: 'queue-nonempty', claimable: 7 } });
    expect(out.force_note as string).toContain('7 claimable');
    expect(registerAwait).toHaveBeenCalled();
  });

  it('an unreadable lane count does NOT wedge the bench (fails open, and says so)', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(null);
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, lane: { verdict: 'unknown', claimable: null } });
  });
});

describe('fleet:bench — list mode', () => {
  it('resolves the caller\'s own fleet when none is passed, and filters to bench-tagged rows', async () => {
    vi.mocked(listFleetAssignments).mockResolvedValueOnce([]);
    vi.mocked(groupByAgent).mockReturnValueOnce([
      { agentId: 'su-worker', fleetSlug: 'p2p-git' } as never,
      { agentId: 'su-other', fleetSlug: 'other-fleet' } as never,
    ]);
    vi.mocked(listParkedAwaitsForSubscribers).mockResolvedValueOnce([
      { subscriberId: 'su-worker', eventKey: 'p2p-git:phase3-open', note: '[fleet:bench] flip TEST hive bridged', expiresTs: null, createdAt: '2026-07-10T12:00:00.000Z' },
    ]);
    const out = await call({ list: true });
    expect(listParkedAwaitsForSubscribers).toHaveBeenCalledWith(['su-worker']);
    expect(out).toMatchObject({
      ok: true,
      fleet: 'p2p-git',
      benched_count: 1,
      benched: [{ member: 'su-worker', event: 'p2p-git:phase3-open', stagedAssignment: 'flip TEST hive bridged' }],
    });
  });

  it('a plain (non-bench) parked await never leaks into the bench roster', async () => {
    vi.mocked(groupByAgent).mockReturnValueOnce([{ agentId: 'su-worker', fleetSlug: 'p2p-git' } as never]);
    vi.mocked(listParkedAwaitsForSubscribers).mockResolvedValueOnce([
      { subscriberId: 'su-worker', eventKey: 'lock:grant:t1', note: null, expiresTs: null, createdAt: '2026-07-10T12:00:00.000Z' },
    ]);
    const out = await call({ list: true });
    expect(out).toMatchObject({ ok: true, benched_count: 0, benched: [] });
  });

  it('an explicit { fleet } overrides the caller\'s own launch-env fleet', async () => {
    vi.mocked(groupByAgent).mockReturnValue([]);
    const out = await call({ list: true, fleet: 'other-fleet' });
    expect(out).toMatchObject({ fleet: 'other-fleet' });
  });

  it('errors clearly when no fleet is resolvable and none was passed', async () => {
    vi.mocked(deriveFleetMembership).mockReturnValueOnce({ fleetSlug: null } as never);
    const out = await call({ list: true });
    expect(out).toMatchObject({ ok: false, error: 'no_fleet' });
    expect(listFleetAssignments).not.toHaveBeenCalled();
  });
});
