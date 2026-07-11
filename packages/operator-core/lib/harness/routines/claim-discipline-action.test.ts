import { describe, expect, it } from 'vitest';
import {
  selectNudgeTargets,
  selectDeclaredPresence,
  nudgeSummary,
  nudgeBody,
  NUDGE_PREFIX,
  filterStoreBackedTargets,
  filterParkedTargets,
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
