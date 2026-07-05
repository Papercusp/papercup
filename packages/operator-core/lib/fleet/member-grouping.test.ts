/**
 * member-grouping — the per-member roster projection (shared-hive-collaboration
 * P-010 / Brief B10). Pure, so these assert the grouping + member-derivation
 * directly with synthetic rows (no PG, no React).
 */
import { describe, it, expect } from 'vitest';
import { deriveMember, groupByMember, type RosterAgent } from './member-grouping';

function agent(p: Partial<RosterAgent> & { agentId: string }): RosterAgent {
  return {
    label: null,
    name: null,
    alive: false,
    heartbeatAt: null,
    load: 0,
    agentPaneKind: 'su',
    ...p,
  };
}

describe('deriveMember', () => {
  it('maps a federated agent to its github user + host from the ownerId', () => {
    const m = deriveMember({ agentId: 'fed:279242982@main-server-tower', label: null });
    expect(m).toEqual({
      key: 'user:279242982',
      displayName: 'gh:279242982', // no label → key-derived display
      host: 'main-server-tower',
      kind: 'user',
    });
  });

  it('prefers the federated label head ("gh:<id> · host") for the display name', () => {
    const m = deriveMember({
      agentId: 'fed:279242982@main-server-tower',
      label: 'gh:279242982 · main-server-Precision-7865',
    });
    expect(m.displayName).toBe('gh:279242982');
    expect(m.host).toBe('main-server-tower');
    expect(m.kind).toBe('user');
  });

  it('handles a federated ownerId with no @host', () => {
    const m = deriveMember({ agentId: 'fed:alice', label: null });
    expect(m).toEqual({ key: 'user:alice', displayName: 'gh:alice', host: null, kind: 'user' });
  });

  it('maps every local session kind to the single local member', () => {
    for (const id of ['su-2ab53e0e-1234', 's-1781389311364-2642f469', 'green-checkpoint', 'mug']) {
      expect(deriveMember({ agentId: id, label: null })).toEqual({
        key: 'local',
        displayName: 'This machine',
        host: null,
        kind: 'local',
      });
    }
  });
});

describe('groupByMember', () => {
  it('returns [] for an empty roster', () => {
    expect(groupByMember([])).toEqual([]);
  });

  it('buckets local + two federated participants into three members', () => {
    const groups = groupByMember([
      agent({ agentId: 'su-aaa', alive: true, load: 2, heartbeatAt: '2026-06-14T03:00:00Z' }),
      agent({ agentId: 'su-bbb', alive: false, load: 0 }),
      agent({ agentId: 'fed:111@boxA', label: 'gh:111 · boxA', alive: true, load: 1, heartbeatAt: '2026-06-14T03:01:00Z' }),
      agent({ agentId: 'fed:222@boxB', label: 'gh:222 · boxB', alive: false, load: 0 }),
    ]);
    expect(groups.map((g) => g.key).sort()).toEqual(['local', 'user:111', 'user:222']);
    const local = groups.find((g) => g.key === 'local')!;
    expect(local.agents).toHaveLength(2);
    expect(local.liveCount).toBe(1);
    expect(local.totalLoad).toBe(2);
    expect(local.lastHeartbeatAt).toBe('2026-06-14T03:00:00Z');
  });

  it('aggregates liveCount / totalLoad / newest heartbeat per member', () => {
    const [g] = groupByMember([
      agent({ agentId: 'fed:7@h', label: 'gh:7 · h', alive: true, load: 3, heartbeatAt: '2026-06-14T01:00:00Z' }),
      agent({ agentId: 'fed:7@h', label: 'gh:7 · h', alive: true, load: 2, heartbeatAt: '2026-06-14T05:00:00Z' }),
      agent({ agentId: 'fed:7@h', label: 'gh:7 · h', alive: false, load: 1, heartbeatAt: '2026-06-14T02:00:00Z' }),
    ]);
    expect(g.key).toBe('user:7');
    expect(g.agents).toHaveLength(3);
    expect(g.liveCount).toBe(2);
    expect(g.totalLoad).toBe(6);
    expect(g.lastHeartbeatAt).toBe('2026-06-14T05:00:00Z'); // newest wins
  });

  it('sorts members with live agents first, then by load', () => {
    const groups = groupByMember([
      // a quiet member (no live agents)
      agent({ agentId: 'fed:quiet@h', label: 'gh:quiet · h', alive: false, load: 9 }),
      // a busy live member
      agent({ agentId: 'fed:busy@h', label: 'gh:busy · h', alive: true, load: 5 }),
      // a lightly-loaded live member
      agent({ agentId: 'fed:light@h', label: 'gh:light · h', alive: true, load: 1 }),
    ]);
    expect(groups.map((g) => g.displayName)).toEqual(['gh:busy', 'gh:light', 'gh:quiet']);
  });

  it('orders agents within a member: live first, then higher load', () => {
    const [g] = groupByMember([
      agent({ agentId: 'fed:1@h', label: 'gh:1 · h', alive: false, load: 4 }),
      agent({ agentId: 'fed:1@h', label: 'gh:1 · h', alive: true, load: 1 }),
      agent({ agentId: 'fed:1@h', label: 'gh:1 · h', alive: true, load: 3 }),
    ]);
    expect(g.agents.map((a) => [a.alive, a.load])).toEqual([
      [true, 3],
      [true, 1],
      [false, 4],
    ]);
  });
});
