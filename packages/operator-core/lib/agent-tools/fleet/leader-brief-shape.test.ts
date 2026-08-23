import { describe, expect, it } from 'vitest';
import leaderBriefTool from './leader-brief';
import { LEADER_BRIEF_SHAPER_BUDGET_CHARS, shapeLeaderBrief } from './leader-brief-shape';

function largeBrief() {
  const members = Array.from({ length: 53 }, (_, index) => ({
    agentId: `su-${String(index).padStart(2, '0')}`,
    verdict: index % 2 === 0 ? 'monitoring' : 'speaking',
    idleCause: index % 2 === 0 ? 'genuinely-idle' : 'working',
    intent: 'x'.repeat(1000),
    doing: { id: `EI-${index}`, title: 'large diagnostic title '.repeat(20), status: 'open' },
    benchSuggestion: { kind: 'laneless-idle', reason: 'x'.repeat(500) },
  }));
  return {
    ok: true,
    blockedAt: {
      layer: 'members',
      reason: '22 members are idle'.repeat(20),
      remedy: 'wake the members'.repeat(20),
      subordinate: members,
      falsifier: { tool: 'work_items:claimable', check: 'x'.repeat(500), kills: 'y'.repeat(500) },
    },
    summary: {
      fleet: 'large-fleet',
      members: members.length,
      dead: 2,
      dead_member_ids: ['su-51', 'su-52'],
      stalled: 3,
      claimable_now: 1432,
      population: { candidates: 63, counted: 53, withheld: 10, basis: 'x'.repeat(1000) },
      pool_capacity: { poolExhausted: false, degraded: false, factor: 1, queueDepth: 0 },
    },
    monitoringBlindAdvisory: {
      line: 'You are monitoring blind: 1/4 required fleet transition event key(s) have live_awaiters:0.',
      missingEventKeys: ['fleet:drained:large-fleet'],
      arm: {
        tool: 'events:await',
        args: { event: '@fleet:large-fleet', note: 'Restore a pushed transition wake; leader control repairs the durable watches.' },
      },
    },
    memberVerdicts: members,
    members,
    unownedCriticals: members,
    customInvariants: members,
    specFilter: { nested: 'x'.repeat(2000) },
    idleCauses: { 'genuinely-idle': 22 },
    strandedFleetAlertReason: 'x'.repeat(1000),
    strandedFleetAlertFalsifier: { tool: 'fleet:capacity', check: 'x'.repeat(1000) },
    campaign: {
      boundary: { at: '2026-08-13T00:00:00.000Z', source: 'fleet-created-at' },
      everMembers: { available: true, count: 53, writer: 'harness_shared.fleet_membership_events' },
      axes: Object.fromEntries(['membership', 'speaking', 'claims', 'terminals', 'issues', 'gateEvents', 'jobs', 'corrections'].map((name) => [name, {
        available: true,
        writer: `writer:${name}`,
        units: { total: 'exact rows from the authoritative writer' },
        cap: { aggregates: 'none', recentRows: 12 },
        data: { total: 53, recent: { total: 53, shown: 12, truncated: true, rows: members.slice(0, 12) } },
      }])),
    },
  };
}

describe('fleet:leader-brief payload projection (EI-20243661938229668)', () => {
  it('declares a bounded shaper and a ceiling below the result-door envelope', () => {
    expect((leaderBriefTool as { shape?: unknown }).shape).toBeDefined();
    expect((leaderBriefTool as { payloadTierCeilingChars?: number }).payloadTierCeilingChars).toBe(
      LEADER_BRIEF_SHAPER_BUDGET_CHARS,
    );
  });

  it('keeps the decision core and returns complete parseable JSON under the budget', () => {
    const out = shapeLeaderBrief(largeBrief(), 'trimmed') as Record<string, unknown>;
    const encoded = JSON.stringify(out);

    expect(() => JSON.parse(encoded)).not.toThrow();
    expect(encoded.length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
    expect(out.ok).toBe(true);
    expect(out.blockedAt).toMatchObject({ layer: 'members' });
    expect(out.summary).toMatchObject({ fleet: 'large-fleet', members: 53, claimable_now: 1432 });
    expect(out.summary).toMatchObject({ dead: 2, dead_member_ids: ['su-51', 'su-52'] });
    expect(out.monitoringBlindAdvisory).toMatchObject({
      line: expect.stringContaining('monitoring blind'),
      arm: { tool: 'events:await', args: { event: '@fleet:large-fleet' } },
    });
    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed' });
    expect(out.campaign).toMatchObject({
      boundary: { source: 'fleet-created-at' },
      axes: { speaking: { available: true, writer: 'writer:speaking' } },
    });
  });

  it('bounds every high-fanout row family with truthful counts and follow-up pointers', () => {
    const out = shapeLeaderBrief(largeBrief(), 'trimmed') as Record<string, unknown>;

    expect((out.memberVerdicts as unknown[]).length).toBeLessThan(53);
    expect(out.memberVerdictsTruncated).toMatchObject({ total: 53, more: expect.stringContaining('payloadTier') });
    expect((out.members as unknown[]).length).toBeLessThan(53);
    expect(out.membersTruncated).toMatchObject({ total: 53 });
    expect(out.unownedCriticalsTruncated).toMatchObject({ total: 53 });
    expect(out.customInvariantsTruncated).toMatchObject({ total: 53 });
    expect(out.specFilterOmitted).toMatchObject({ reason: 'bounded for monitor transport' });
  });

  it('keeps every bench target in a complete exceptional index when member rows are truncated', () => {
    const members = [
      ...Array.from({ length: 20 }, (_, index) => ({ agentId: `ordinary-${index}`, verdict: 'monitoring' })),
      { agentId: 'bench-a', verdict: 'monitoring', benchSuggestion: { kind: 'laneless-idle' } },
      { agentId: 'bench-b', verdict: 'monitoring', benchSuggestion: { kind: 'stalled-no-mcp' } },
      { agentId: 'bench-c', verdict: 'monitoring', benchSuggestion: { kind: 'idle-with-claimable' } },
    ];
    const out = shapeLeaderBrief(
      {
        ok: true,
        summary: { fleet: 'bench-fleet', members: members.length, bench_suggested: 3, laneless_idle: 1 },
        members,
        benchSuggestions: [
          { agentId: 'bench-a', kind: 'laneless-idle' },
          { agentId: 'bench-b', kind: 'stalled-no-mcp' },
          { agentId: 'bench-c', kind: 'idle-with-claimable' },
        ],
      },
      'trimmed',
    ) as Record<string, unknown>;

    expect(out.benchSuggestions).toEqual([
      { agentId: 'bench-a', kind: 'laneless-idle' },
      { agentId: 'bench-b', kind: 'stalled-no-mcp' },
      { agentId: 'bench-c', kind: 'idle-with-claimable' },
    ]);
    expect(out.summary).toMatchObject({ bench_suggested: 3 });
    expect((out.members as Array<{ agentId: string }>).some((member) => member.agentId === 'bench-a')).toBe(false);
  });

  it('preserves the monitoring-blind advisory in the emergency byte-pressure projection', () => {
    const input = largeBrief();
    input.campaign.axes = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `axis-${index}`,
        {
          available: true,
          writer: `writer:${index}:${'x'.repeat(300)}`,
          units: { total: 'x'.repeat(300) },
          cap: { aggregates: 'none', recentRows: 0 },
          data: {
            total: index,
            recent: { total: 0, shown: 0, truncated: false, rows: [] },
          },
        },
      ]),
    );

    const out = shapeLeaderBrief(input, 'trimmed') as Record<string, unknown>;

    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed', emergency: true });
    expect(out.monitoringBlindAdvisory).toMatchObject({
      line: expect.stringContaining('monitoring blind'),
      arm: { tool: 'events:await', args: { event: '@fleet:large-fleet' } },
    });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(LEADER_BRIEF_SHAPER_BUDGET_CHARS);
  });
});
