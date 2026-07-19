import { describe, expect, it } from 'vitest';
import {
  selectNudgeTargets,
  selectDeclaredPresence,
  nudgeSummary,
  nudgeBody,
  NUDGE_PREFIX,
  filterRecentlyCompletedTargets,
  filterStoreBackedTargets,
  filterTerminalPlanTargets,
  filterParkedTargets,
  filterHealthyLoopTargets,
  filterDrainedTargets,
  recentCompletionKey,
  storeExistsKey,
} from './claim-discipline-action';
import type { PresenceRecord } from '@papercusp/coordination/presence';

function declaredPresence(over: {
  agentId: string;
  alive?: boolean;
  declaredPlanSlug?: string | null;
}) {
  return {
    agentId: over.agentId,
    alive: over.alive ?? true,
    declaredPlanSlug: over.declaredPlanSlug === undefined ? 'plan-a' : over.declaredPlanSlug,
  };
}

function presenceRecord(over: {
  owner_id: string;
  heartbeat_at?: string;
  current_plan_slug?: string | null;
  revoked?: boolean;
}): PresenceRecord {
  const now = new Date();
  const recentHeartbeat = over.heartbeat_at ?? now.toISOString();
  return {
    ownerId: over.owner_id,
    ownerLabel: 'test',
    workspaceId: 'test-workspace',
    source: 'session',
    intent: 'working',
    currentPlanSlug: over.current_plan_slug ?? null,
    currentFiles: [],
    host: 'localhost',
    pid: null,
    startedAt: now.toISOString(),
    heartbeatAt: recentHeartbeat,
    lastActiveAt: recentHeartbeat,
    intentDeclaredAt: recentHeartbeat,
    agentRole: null,
    potSlug: null,
    capabilityTags: [],
    stale: false,
    userId: 'user-1',
    revoked: over.revoked ?? false,
  };
}

describe('selectDeclaredPresence', () => {
  it('filters out revoked sessions even with fresh heartbeat and declared plan', () => {
    const rows: PresenceRecord[] = [
      presenceRecord({ owner_id: 'a', current_plan_slug: 'plan-x' }),
      presenceRecord({ owner_id: 'b', current_plan_slug: 'plan-x', revoked: true }),
      presenceRecord({ owner_id: 'c', current_plan_slug: 'plan-x' }),
    ];
    const result = selectDeclaredPresence(rows);
    expect(result.map((r) => r.agentId)).toEqual(['a', 'c']);
    expect(result.every((r) => !rows.find((pr) => pr.revoked && pr.ownerId === r.agentId))).toBe(true);
  });

  it('filters out stale heartbeats', () => {
    const now = Date.now();
    const staleHeartbeat = new Date(now - 11 * 60 * 1000).toISOString(); // 11 minutes old
    const rows: PresenceRecord[] = [
      presenceRecord({ owner_id: 'a', current_plan_slug: 'plan-x' }),
      presenceRecord({ owner_id: 'b', current_plan_slug: 'plan-x', heartbeat_at: staleHeartbeat }),
    ];
    const result = selectDeclaredPresence(rows);
    expect(result.map((r) => r.agentId)).toEqual(['a']);
  });

  it('includes agents with no declared plan (null currentPlanSlug)', () => {
    const rows: PresenceRecord[] = [
      presenceRecord({ owner_id: 'a', current_plan_slug: 'plan-x' }),
      presenceRecord({ owner_id: 'b', current_plan_slug: null }),
    ];
    const result = selectDeclaredPresence(rows);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.agentId === 'b')).toEqual({
      agentId: 'b',
      alive: true,
      declaredPlanSlug: null,
    });
  });
});

describe('selectNudgeTargets', () => {
  it('targets alive declared-unclaimed agents only', () => {
    const declared = [
      declaredPresence({ agentId: 'a' }), // target
      declaredPresence({ agentId: 'b', declaredPlanSlug: 'plan-a' }), // has claimed on plan-a
      declaredPresence({ agentId: 'c', alive: false }), // dead — orphan handling's job, not a nudge
      declaredPresence({ agentId: 'd', declaredPlanSlug: null }), // ad-hoc work, nothing to claim
    ];
    const claimed = new Map([
      ['b', new Set(['plan-a'])], // b claimed on plan-a
    ]);
    const targets = selectNudgeTargets(declared, claimed, new Set());
    expect(targets.map((t) => t.agentId)).toEqual(['a']);
  });

  it('skips agents inside the throttle window', () => {
    const declared = [declaredPresence({ agentId: 'a' }), declaredPresence({ agentId: 'b' })];
    const targets = selectNudgeTargets(declared, new Map(), new Set(['a']));
    expect(targets.map((t) => t.agentId)).toEqual(['b']);
  });

  it('does not target agents with declared plans but no claimed plans', () => {
    const declared = [declaredPresence({ agentId: 'a', declaredPlanSlug: 'plan-x' })];
    const claimed = new Map([['a', new Set(['plan-x'])]]);
    const targets = selectNudgeTargets(declared, claimed, new Set());
    expect(targets).toEqual([]);
  });
});

describe('filterStoreBackedTargets — EI-7402', () => {
  it('drops a target whose declared plan is AFFIRMED absent from the store', () => {
    const targets = [declaredPresence({ agentId: 'a', declaredPlanSlug: 'file-only-plan' })];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const existsByKey = new Map([[storeExistsKey('ws1', 'file-only-plan'), false]]);
    const { keep, skippedStoreAbsent } = filterStoreBackedTargets(targets, workspaceByAgent, existsByKey);
    expect(keep).toEqual([]);
    expect(skippedStoreAbsent).toBe(1);
  });

  it('keeps a target whose declared plan IS backed by a store row', () => {
    const targets = [declaredPresence({ agentId: 'a', declaredPlanSlug: 'real-plan' })];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const existsByKey = new Map([[storeExistsKey('ws1', 'real-plan'), true]]);
    const { keep, skippedStoreAbsent } = filterStoreBackedTargets(targets, workspaceByAgent, existsByKey);
    expect(keep.map((t) => t.agentId)).toEqual(['a']);
    expect(skippedStoreAbsent).toBe(0);
  });

  it('fails OPEN (keeps) when the existence lookup is missing from the map', () => {
    const targets = [declaredPresence({ agentId: 'a', declaredPlanSlug: 'unresolved-plan' })];
    const { keep, skippedStoreAbsent } = filterStoreBackedTargets(targets, new Map(), new Map());
    expect(keep.map((t) => t.agentId)).toEqual(['a']);
    expect(skippedStoreAbsent).toBe(0);
  });

  it('scopes existence by workspace — the same plan slug in a different workspace is independent', () => {
    const targets = [
      declaredPresence({ agentId: 'a', declaredPlanSlug: 'shared-slug' }),
      declaredPresence({ agentId: 'b', declaredPlanSlug: 'shared-slug' }),
    ];
    const workspaceByAgent = new Map([
      ['a', 'ws1'],
      ['b', 'ws2'],
    ]);
    const existsByKey = new Map([
      [storeExistsKey('ws1', 'shared-slug'), true],
      [storeExistsKey('ws2', 'shared-slug'), false],
    ]);
    const { keep, skippedStoreAbsent } = filterStoreBackedTargets(targets, workspaceByAgent, existsByKey);
    expect(keep.map((t) => t.agentId)).toEqual(['a']);
    expect(skippedStoreAbsent).toBe(1);
  });
});

describe('filterTerminalPlanTargets — EI-16176', () => {
  const t = (agentId: string, declaredPlanSlug = 'plan-a') => ({ agentId, declaredPlanSlug });

  it('drops a target whose declared plan has SHIPPED', () => {
    const targets = [t('a')];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const terminalityByKey = new Map([
      [storeExistsKey('ws1', 'plan-a'), { status: 'shipped', hasOpenItems: false }],
    ]);
    const { keep, skippedTerminalPlan } = filterTerminalPlanTargets(targets, workspaceByAgent, terminalityByKey);
    expect(keep).toEqual([]);
    expect(skippedTerminalPlan).toBe(1);
  });

  it('drops a target whose declared plan has been SUPERSEDED', () => {
    const targets = [t('a')];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const terminalityByKey = new Map([
      [storeExistsKey('ws1', 'plan-a'), { status: 'superseded', hasOpenItems: false }],
    ]);
    const { keep, skippedTerminalPlan } = filterTerminalPlanTargets(targets, workspaceByAgent, terminalityByKey);
    expect(keep).toEqual([]);
    expect(skippedTerminalPlan).toBe(1);
  });

  it('drops a target whose plan is still active-status but has zero OPEN items', () => {
    const targets = [t('a')];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const terminalityByKey = new Map([
      [storeExistsKey('ws1', 'plan-a'), { status: 'active', hasOpenItems: false }],
    ]);
    const { keep, skippedTerminalPlan } = filterTerminalPlanTargets(targets, workspaceByAgent, terminalityByKey);
    expect(keep).toEqual([]);
    expect(skippedTerminalPlan).toBe(1);
  });

  it('keeps a target whose plan is active with at least one open item — unchanged behavior', () => {
    const targets = [t('a')];
    const workspaceByAgent = new Map([['a', 'ws1']]);
    const terminalityByKey = new Map([
      [storeExistsKey('ws1', 'plan-a'), { status: 'active', hasOpenItems: true }],
    ]);
    const { keep, skippedTerminalPlan } = filterTerminalPlanTargets(targets, workspaceByAgent, terminalityByKey);
    expect(keep.map((x) => x.agentId)).toEqual(['a']);
    expect(skippedTerminalPlan).toBe(0);
  });

  it('fails OPEN (keeps, nudges) when the terminality lookup is missing/null — a lookup failure', () => {
    const targets = [t('a')];
    const { keep, skippedTerminalPlan } = filterTerminalPlanTargets(targets, new Map([['a', 'ws1']]), new Map());
    expect(keep.map((x) => x.agentId)).toEqual(['a']);
    expect(skippedTerminalPlan).toBe(0);
  });
});

describe('filterRecentlyCompletedTargets — EI-13286', () => {
  const now = Date.parse('2026-07-17T02:00:00.000Z');

  it('suppresses a fresh same-owner completion after its plan-item claim is released', () => {
    const targets = [
      declaredPresence({ agentId: 'finished', declaredPlanSlug: 'finished-plan' }),
      declaredPresence({ agentId: 'working', declaredPlanSlug: 'active-plan' }),
    ];
    const workspaceByAgent = new Map([
      ['finished', 'ws1'],
      ['working', 'ws1'],
    ]);
    const completedAtByKey = new Map([
      [recentCompletionKey('ws1', 'finished', 'finished-plan'), now - 60_000],
    ]);
    const declaredAt = new Map([
      ['finished', '2026-07-17T01:30:00.000Z'],
      ['working', '2026-07-17T01:30:00.000Z'],
    ]);

    const result = filterRecentlyCompletedTargets(
      targets,
      workspaceByAgent,
      completedAtByKey,
      declaredAt,
      now,
    );
    expect(result.keep.map((target) => target.agentId)).toEqual(['working']);
    expect(result.skippedRecentlyCompleted).toBe(1);
  });

  it('does not let an older completion suppress a newly declared lane', () => {
    const targets = [declaredPresence({ agentId: 'same', declaredPlanSlug: 'plan-a' })];
    const result = filterRecentlyCompletedTargets(
      targets,
      new Map([['same', 'ws1']]),
      new Map([[recentCompletionKey('ws1', 'same', 'plan-a'), now - 2 * 60_000]]),
      new Map([['same', '2026-07-17T01:59:00.000Z']]),
      now,
    );
    expect(result.keep).toEqual(targets);
    expect(result.skippedRecentlyCompleted).toBe(0);
  });

  it('fails open when completion evidence or declaration time is missing', () => {
    const missingCompletion = [declaredPresence({ agentId: 'unknown', declaredPlanSlug: 'plan-a' })];
    const noCompletion = filterRecentlyCompletedTargets(
      missingCompletion,
      new Map([['unknown', 'ws1']]),
      new Map(),
      new Map([['unknown', '2026-07-17T01:30:00.000Z']]),
      now,
    );
    expect(noCompletion.keep).toEqual(missingCompletion);

    const missingDeclaration = [declaredPresence({ agentId: 'no-intent-ts', declaredPlanSlug: 'plan-a' })];
    const noDeclaration = filterRecentlyCompletedTargets(
      missingDeclaration,
      new Map([['no-intent-ts', 'ws1']]),
      new Map([[recentCompletionKey('ws1', 'no-intent-ts', 'plan-a'), now - 60_000]]),
      new Map(),
      now,
    );
    expect(noDeclaration.keep).toEqual(missingDeclaration);
  });
});

describe('nudge content', () => {
  it('summary carries the throttle marker prefix and the plan', () => {
    const s = nudgeSummary('plan-a');
    expect(s.startsWith(NUDGE_PREFIX)).toBe(true);
    expect(s).toContain('plan-a');
  });

  it('body teaches both claim paths', () => {
    const b = nudgeBody('plan-a');
    expect(b).toContain("plans:set-status");
    expect(b).toContain('coord:declare-intent');
    expect(b).toContain('plan-a');
  });
});

describe('filterParkedTargets — P-002 fleet-member-dx (EI-9014)', () => {
  const t = (agentId: string) => ({ agentId, declaredPlanSlug: 'plan-a' });

  it('skips an agent parked on a real events:await and reports the awaited key', () => {
    const parked = new Map([['a1', ['p2p-git:phase3-open']]]);
    const { keep, skippedParked } = filterParkedTargets([t('a1'), t('a2')], parked);
    expect(keep.map((x) => x.agentId)).toEqual(['a2']);
    expect(skippedParked).toEqual([{ agentId: 'a1', parkedOn: 'p2p-git:phase3-open' }]);
  });

  it('an empty parked map (incl. the failed-read fallback) keeps every target — fail-open to nudging', () => {
    const { keep, skippedParked } = filterParkedTargets([t('a1'), t('a2')], new Map());
    expect(keep).toHaveLength(2);
    expect(skippedParked).toHaveLength(0);
  });

  it('an agent whose key list is EMPTY is not parked', () => {
    const { keep, skippedParked } = filterParkedTargets([t('a1')], new Map([['a1', [] as string[]]]));
    expect(keep).toHaveLength(1);
    expect(skippedParked).toHaveLength(0);
  });

  it('multiple parked keys: the first is the reported bench reason', () => {
    const parked = new Map([['a1', ['gate:green', 'deploy:done']]]);
    const { skippedParked } = filterParkedTargets([t('a1')], parked);
    expect(skippedParked[0]?.parkedOn).toBe('gate:green');
  });
});

describe('filterHealthyLoopTargets — P-010 agent-operability (EI-11402)', () => {
  const t = (agentId: string) => ({ agentId, declaredPlanSlug: 'plan-a' });

  it('suppresses a healthy loop-owned monitor and keeps ordinary unclaimed agents', () => {
    const { keep, skippedLoopOwned } = filterHealthyLoopTargets(
      [t('monitor'), t('ordinary')],
      new Set(['monitor']),
    );
    expect(keep.map((x) => x.agentId)).toEqual(['ordinary']);
    expect(skippedLoopOwned).toEqual(['monitor']);
  });

  it('an empty/fail-open loop set suppresses nobody', () => {
    const { keep, skippedLoopOwned } = filterHealthyLoopTargets([t('a1')], new Set());
    expect(keep).toHaveLength(1);
    expect(skippedLoopOwned).toEqual([]);
  });
});

describe('filterDrainedTargets — EI-11881 claim-discipline recurrence guard', () => {
  const now = Date.parse('2026-07-14T04:00:00.000Z');
  const t = (agentId: string) => ({ agentId, declaredPlanSlug: 'plan-a' });

  it('suppresses a member after a recent authoritative drain, but re-opens after the signal ages out', () => {
    const targets = [t('drained'), t('ordinary')];
    const drainedAt = new Map([['drained', '2026-07-14T03:58:00.000Z']]);
    const declaredAt = new Map([
      ['drained', '2026-07-14T03:50:00.000Z'],
      ['ordinary', '2026-07-14T03:50:00.000Z'],
    ]);

    const recent = filterDrainedTargets(targets, drainedAt, declaredAt, now);
    expect(recent.keep.map((x) => x.agentId)).toEqual(['ordinary']);
    expect(recent.skippedDrained).toEqual(['drained']);

    const agedOut = filterDrainedTargets(targets, new Map([['drained', '2026-07-14T03:49:00.000Z']]), declaredAt, now);
    expect(agedOut.keep.map((x) => x.agentId)).toEqual(['drained', 'ordinary']);
    expect(agedOut.skippedDrained).toEqual([]);
  });

  it('does not suppress a new declaration made after an older drain, and fails open on missing timestamps', () => {
    const targets = [t('new-wave'), t('unknown')];
    const drainedAt = new Map([['new-wave', '2026-07-14T03:55:00.000Z']]);
    const declaredAt = new Map([
      ['new-wave', '2026-07-14T03:59:00.000Z'],
      ['unknown', null],
    ]);
    const result = filterDrainedTargets(targets, drainedAt, declaredAt, now);
    expect(result.keep.map((x) => x.agentId)).toEqual(['new-wave', 'unknown']);
    expect(result.skippedDrained).toEqual([]);
  });
});
