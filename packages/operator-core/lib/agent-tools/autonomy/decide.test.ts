import { describe, it, expect, beforeEach, vi } from 'vitest';
import decideTool from './decide';
import { resolveAutonomyDecision, defaultDeciderDeps } from '../../autonomy/decider';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: the decider (lib/autonomy/decider.ts) has its own suite; this
// pins the TOOL — workspace resolution (principal vs '*' vs active), the
// only-defined-fields action spread, the deps wiring, and the envelope
// (queen-autonomy-policy-2026-06-13 B-12 / P-070).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/decider', () => ({
  resolveAutonomyDecision: vi.fn(),
  defaultDeciderDeps: vi.fn(),
}));

const mockResolve = vi.mocked(resolveAutonomyDecision);
const mockDeps = vi.mocked(defaultDeciderDeps);
const mockActiveWs = vi.mocked(activeWorkspaceId);

const DECISION = { verdict: 'gated', category: 'system-control', reasons: ['armed=off'] };

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    decideTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:decide tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockDeps.mockReturnValue({ sentinel: 'deps' } as unknown as ReturnType<typeof defaultDeciderDeps>);
    mockResolve.mockResolvedValue(DECISION as unknown as Awaited<ReturnType<typeof resolveAutonomyDecision>>);
  });

  it('resolves a concrete principal workspace; falls back to active for "*" / no principal', async () => {
    await callTool({ action: 'blender:grade-idea' }, { principal: { workspaceId: 'ws-prin' } });
    expect(mockDeps).toHaveBeenCalledWith(expect.anything(), 'ws-prin');

    mockDeps.mockClear();
    await callTool({ action: 'blender:grade-idea' }, { principal: { workspaceId: '*' } });
    expect(mockDeps).toHaveBeenCalledWith(expect.anything(), 'ws-active');

    mockDeps.mockClear();
    await callTool({ action: 'blender:grade-idea' }, {});
    expect(mockDeps).toHaveBeenCalledWith(expect.anything(), 'ws-active');
  });

  it('passes ONLY the action when optional axes are omitted (no undefined keys)', async () => {
    await callTool({ action: 'blender:grade-idea' });
    expect(mockResolve).toHaveBeenCalledWith({ action: 'blender:grade-idea' }, { sentinel: 'deps' });
    // the action object carries no capability/riskTier/authority/reversibility keys
    expect(Object.keys(mockResolve.mock.calls[0][0])).toEqual(['action']);
  });

  it('forwards every provided axis to the decider', async () => {
    await callTool({
      action: 'docs:publish',
      capability: 'docs:write',
      riskTier: 'low',
      authority: 'system',
      reversibility: 'reversible',
    });
    expect(mockResolve).toHaveBeenCalledWith(
      {
        action: 'docs:publish',
        capability: 'docs:write',
        riskTier: 'low',
        authority: 'system',
        reversibility: 'reversible',
      },
      { sentinel: 'deps' },
    );
  });

  it('returns { ok, workspaceId, decision } from the gate', async () => {
    const res = await callTool({ action: 'x' }, { principal: { workspaceId: 'ws-prin' } });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, workspaceId: 'ws-prin', decision: DECISION });
  });

  // ── overwatch envelope dispatch (overwatch-role-2026-06-15 B-06 / D-002) ──
  // When the caller is the overwatch role the tool applies the overwatch gate
  // (the real, pure lib/overwatch/autonomy.ts — NOT mocked) and SKIPS the Queen
  // decider entirely. nudge/observe/escalate → auto; structural → gated.
  describe('overwatch envelope (B-06)', () => {
    it('AUTO-decides a nudge and never touches the Queen decider (role arg)', async () => {
      const res = await callTool({ action: 'coord:send', role: 'kettle' });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.role).toBe('kettle');
      expect(body.workspaceId).toBe('ws-active');
      expect(body.decision.posture).toBe('auto');
      expect(body.decision.actionClass).toBe('nudge');
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockDeps).not.toHaveBeenCalled();
    });

    it('dispatches on ctx.role when no role arg is given', async () => {
      const res = await callTool({ action: 'improvements:capture' }, { role: 'kettle' });
      const body = JSON.parse(res.content[0].text);
      expect(body.role).toBe('kettle');
      expect(body.decision.posture).toBe('auto');
      expect(body.decision.actionClass).toBe('observe');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('GATES a structural action (escalate-only)', async () => {
      const res = await callTool({ action: 'processes:kill', role: 'kettle' });
      const body = JSON.parse(res.content[0].text);
      expect(body.decision.posture).toBe('gated');
      expect(body.decision.escalateOnly).toBe(true);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('a non-overwatch role still uses the Queen decider', async () => {
      await callTool({ action: 'coord:send', role: 'mug' });
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    // WI-1756049 recurrence guard. The dispatch branch compares against the literal
    // "kettle", which reads like leftovers from the retired mug/kettle/cup tier and
    // invites a well-meaning cleanup to rewrite it to "overwatch". It is not
    // leftovers: "kettle" IS Overwatch's wire identifier (OVERWATCH_ROLE), the same
    // value its autoloop_state rows are keyed by.
    //
    // Renaming it would not fail loudly — it would silently route Overwatch into the
    // 13-category gate, whose ceilings are all ARMED at `critical`, so a structural
    // action that must be escalate-only could come back `auto`. These two assertions
    // exist so that rename fails HERE, with the reason, instead of in production.
    it('dispatches on OVERWATCH_ROLE’s wire value, which is "kettle" and is NOT tier residue', async () => {
      const { OVERWATCH_ROLE } = await import('../../overwatch/liveness');
      expect(OVERWATCH_ROLE).toBe('kettle');

      mockResolve.mockClear();
      const res = await callTool({ action: 'processes:kill', role: OVERWATCH_ROLE });
      const body = JSON.parse(res.content[0].text);

      // Took the overwatch envelope (escalate-only), NOT the risk x ceiling gate.
      expect(body.decision.escalateOnly).toBe(true);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('renaming the branch to "overwatch" would break the envelope — positive control', async () => {
      // The counterfactual the guard above protects: the string a cleanup would
      // "correct" to does NOT select the overwatch envelope; it falls through to the
      // 13-category decider. If this ever stops being true the comparison changed.
      mockResolve.mockClear();
      await callTool({ action: 'processes:kill', role: 'overwatch' });
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });
  });
});
