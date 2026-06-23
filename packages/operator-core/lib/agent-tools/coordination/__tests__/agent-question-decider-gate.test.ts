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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentIdentity, IdentitySource } from '../identity';
import { deciderAgentQuestionGate, postureToRung } from '../agent-question-decider-gate';

// QUEEN_AUTONOMY_ARMED graduated to default-ON (flip-dark-flags-default-on-2026-06-23). These tests
// verify the UNARMED gate (owner-queue routing), so pin the arming flag OFF via the env override
// (this file uses the real getFlag, which honors PAPERCUSP_FLAG_* over the default) rather than
// depending on the now-ON default. The armed auto→bee-self mapping is covered by postureToRung above.
// Pin BOTH autonomy flags OFF: QUEEN_FULL_AUTONOMY overrides every gate → auto, so the unarmed
// (owner-queue) path requires the full-autonomy grant OFF too, not just the arming flag.
const ARMED_ENVS = ['PAPERCUSP_FLAG_PAPERCUSP_QUEEN_AUTONOMY_ARMED', 'PAPERCUSP_FLAG_PAPERCUSP_QUEEN_FULL_AUTONOMY'];
beforeEach(() => {
  for (const e of ARMED_ENVS) process.env[e] = '0';
});
afterEach(() => {
  for (const e of ARMED_ENVS) delete process.env[e];
});

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
