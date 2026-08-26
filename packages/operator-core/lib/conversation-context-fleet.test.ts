import { describe, expect, it, vi } from 'vitest';
import {
  buildFleetContextFrame,
  loadFleetContextFrame,
  type FleetContextAgent,
  type FleetContextDependencies,
} from './conversation-context-fleet';
import type { AgentClaim } from './fleet/assignments';
import type { AwaitRow } from './events/await/types';

function planClaim(id: string, planSlug = 'plan-a'): AgentClaim {
  return {
    type: 'plan-item',
    harnessSlug: 'papercusp',
    planSlug,
    id,
    itemKind: null,
    detail: id,
    status: 'wip',
    acquiredTs: '2026-08-26T00:00:00Z',
    expiresTs: null,
    active: true,
    orphaned: false,
    stalled: false,
    lastProgressAt: '2026-08-26T00:00:00Z',
    activity: 'progressing',
    rank: null,
    rankWriter: null,
  };
}

function agent(overrides: Partial<FleetContextAgent> & Pick<FleetContextAgent, 'agentId'>): FleetContextAgent {
  const { agentId, ...rest } = overrides;
  return {
    agentId,
    label: agentId,
    name: null,
    present: true,
    alive: true,
    heartbeatAt: '2026-08-26T00:00:00Z',
    intent: '',
    declaredPlanSlug: 'plan-a',
    fleetSlug: 'fleet-a',
    fleetRole: 'member',
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...rest,
  };
}

function announcement(overrides: Partial<AwaitRow> = {}): AwaitRow {
  return {
    id: 1,
    workspaceId: 'default',
    subscriberId: 'su-leader',
    eventKey: 'fleet:fleet-a:contract-ready',
    policy: 'announce',
    note: 'contract ready',
    wakeHandle: null,
    timeoutBehavior: 'expire',
    expiresTs: null,
    createdAt: '2026-08-26T00:00:00Z',
    firedAt: null,
    firedReason: null,
    cancelledAt: null,
    cancelReason: null,
    once: true,
    minSleepSec: null,
    urgency: false,
    payloadFilter: null,
    scopeKind: 'fleet',
    scopeRef: 'fleet-a',
    ...overrides,
  };
}

describe('conversation fleet context', () => {
  it('projects roster, parked gate and one live blocked-by edge', () => {
    const self = agent({
      agentId: 'su-self',
      label: 'Self',
      fleetRole: 'member',
      sessionState: 'live',
      parkedOn: ['fleet:fleet-a:contract-ready'],
      claims: [planClaim('P-025')],
    });
    const leader = agent({
      agentId: 'su-leader',
      label: 'Leader',
      fleetRole: 'leader',
      sessionState: 'live',
      contextPressure: 'high',
      lastToolCallAt: '2026-08-26T00:50:00Z',
      claims: [planClaim('P-006')],
    });

    const frame = buildFleetContextFrame({
      ownerId: 'su-self',
      fleetSlug: 'fleet-a',
      planSlug: 'plan-a',
      agents: [self, leader],
      announcements: [announcement()],
      planItems: [
        { id: 'P-006', storedStatus: 'wip', blockedBy: [] },
        { id: 'P-025', storedStatus: 'todo', blockedBy: ['P-006'] },
      ],
      nowMs: Date.parse('2026-08-26T01:00:00Z'),
    });

    expect(frame).toMatchObject({ id: 'context:fleet', section: 'fleet', title: 'Fleet' });
    expect(frame?.entries.find((entry) => entry.label === 'Leader')?.value).toBe('Leader');
    expect(frame?.entries.find((entry) => entry.label === 'Roster')?.badges).toEqual([
      expect.objectContaining({ label: '◆', state: 'live', title: 'Leader · live' }),
      expect.objectContaining({ label: '●', state: 'live', title: 'Self · live' }),
    ]);
    expect(frame?.entries.find((entry) => entry.label === 'Parked gate')).toMatchObject({
      value: 'fleet:fleet-a:contract-ready',
      state: 'waiting',
    });
    expect(frame?.entries.find((entry) => entry.label === 'Blocked by')).toMatchObject({
      value: 'plan-a#P-006 · Leader · pressure high · spoke 10m ago',
      state: 'high',
    });
  });

  it('uses one assignment read and omits unavailable optional enrichments', async () => {
    const listAssignments = vi.fn(async () => []);
    const self = agent({ agentId: 'su-self', fleetRole: 'member' });
    const passthrough = async (agents: FleetContextAgent[]) => agents;
    const deps: FleetContextDependencies = {
      listAssignments,
      groupAssignments: () => [self],
      reconcileWakeability: async () => { throw new Error('optional liveness unavailable'); },
      decorateParkedOn: passthrough,
      decorateContextPressure: passthrough,
      decorateMemberVerdicts: passthrough,
      listAnnouncements: async () => [],
      readPlan: async () => null,
      now: () => 0,
    };

    const frame = await loadFleetContextFrame({
      workspaceId: 'ws',
      harness: 'papercusp',
      ownerId: 'su-self',
      fleetSlug: 'fleet-a',
      planSlug: 'plan-a',
    }, deps);

    expect(listAssignments).toHaveBeenCalledTimes(1);
    expect(listAssignments).toHaveBeenCalledWith({
      workspaceId: 'ws',
      harness: 'papercusp',
      fleet: 'fleet-a',
    });
    expect(frame?.entries.map((entry) => entry.label)).toEqual([
      'Fleet', 'Leader', 'Your role', 'Roster',
    ]);
  });
});
