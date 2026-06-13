import { describe, expect, it } from 'vitest';
import { selectNudgeTargets, selectDeclaredPresence, nudgeSummary, nudgeBody, NUDGE_PREFIX } from './claim-discipline-action';

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
