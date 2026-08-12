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
      stalled: 3,
      claimable_now: 1432,
      population: { candidates: 63, counted: 53, withheld: 10, basis: 'x'.repeat(1000) },
      pool_capacity: { poolExhausted: false, degraded: false, factor: 1, queueDepth: 0 },
    },
    memberVerdicts: members,
    members,
    unownedCriticals: members,
    customInvariants: members,
    specFilter: { nested: 'x'.repeat(2000) },
    idleCauses: { 'genuinely-idle': 22 },
    strandedFleetAlertReason: 'x'.repeat(1000),
    strandedFleetAlertFalsifier: { tool: 'fleet:capacity', check: 'x'.repeat(1000) },
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
    expect(out.leaderBriefProjection).toMatchObject({ tier: 'trimmed' });
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
});

