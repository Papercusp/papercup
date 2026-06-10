import { describe, expect, it } from 'vitest';
import { selectNudgeTargets, nudgeSummary, nudgeBody, NUDGE_PREFIX } from './claim-discipline-action';

function agent(over: {
  agentId: string;
  alive?: boolean;
  declaredUnclaimed?: boolean;
  declaredPlanSlug?: string | null;
}) {
  return {
    agentId: over.agentId,
    alive: over.alive ?? true,
    declaredUnclaimed: over.declaredUnclaimed ?? true,
    declaredPlanSlug: over.declaredPlanSlug === undefined ? 'plan-a' : over.declaredPlanSlug,
  };
}

describe('selectNudgeTargets', () => {
  it('targets alive declared-unclaimed agents only', () => {
    const targets = selectNudgeTargets(
      [
        agent({ agentId: 'a' }), // target
        agent({ agentId: 'b', declaredUnclaimed: false }), // claimed its lane
        agent({ agentId: 'c', alive: false }), // dead — orphan handling's job, not a nudge
        agent({ agentId: 'd', declaredPlanSlug: null }), // ad-hoc work, nothing to claim
      ],
      new Set(),
    );
    expect(targets.map((t) => t.agentId)).toEqual(['a']);
  });

  it('skips agents inside the throttle window', () => {
    const targets = selectNudgeTargets(
      [agent({ agentId: 'a' }), agent({ agentId: 'b' })],
      new Set(['a']),
    );
    expect(targets.map((t) => t.agentId)).toEqual(['b']);
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
