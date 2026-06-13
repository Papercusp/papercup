// @vitest-environment node
/**
 * agent-question-decider-gate — the B-10 ⇄ B-12 bridge (queen-autonomous-execution
 * B-17 seam-gap). Covers the posture→rung contract (pure) and that the live
 * decider-backed gate is BEHAVIOR-NEUTRAL / fail-safe — it returns owner-Queue while
 * the autonomy policy is unarmed (the only state until the owner's P-092 gate) and on
 * any IO failure. The armed `auto → bee-self` mapping is proven by `postureToRung`
 * (the gate body is a one-line `postureToRung(decision.posture)`); the decider's own
 * suite covers when it returns `auto`.
 */
import { describe, expect, it } from 'vitest';

import type { AgentIdentity, IdentitySource } from '../identity';
import { deciderAgentQuestionGate, postureToRung } from '../agent-question-decider-gate';

const idOf = (source: IdentitySource): AgentIdentity => ({
  ownerId: `owner-${source}`,
  ownerLabel: source,
  source,
  workspaceId: 'ws-1',
  userId: null,
});

describe('postureToRung (the B-10⇄B-12 contract)', () => {
  it('gated → owner-queue (the owner answers via the D-011 Queue)', () => {
    expect(postureToRung('gated')).toBe('owner-queue');
  });
  it('auto → bee-self (the bee may self-answer-with-undo; P-040)', () => {
    expect(postureToRung('auto')).toBe('bee-self');
  });
});

describe('deciderAgentQuestionGate (behavior-neutral / fail-safe)', () => {
  it('routes a context-free question to owner-Queue while unarmed (D-007)', async () => {
    const r = await deciderAgentQuestionGate({
      identity: idOf('fleet-spawn'),
      question: 'deploy now?',
      options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }],
    });
    expect(r).toEqual({ rung: 'owner-queue' });
  });

  it('routes a question WITH decision-context to owner-Queue while unarmed', async () => {
    // Even a reversible, low-risk, mapped action gates while QUEEN_AUTONOMY_ARMED is
    // OFF — the arming flag is the load-bearing floor (B-19).
    const r = await deciderAgentQuestionGate({
      identity: idOf('signed-spawn'),
      question: 'rename this local variable?',
      options: [{ id: 'a', label: 'Yes' }],
      action: 'plans:set-status',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
    });
    expect(r).toEqual({ rung: 'owner-queue' });
  });
});
