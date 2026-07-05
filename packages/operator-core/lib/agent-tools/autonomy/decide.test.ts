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
      const res = await callTool({ action: 'coord:send', role: 'overwatch' });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.role).toBe('overwatch');
      expect(body.workspaceId).toBe('ws-active');
      expect(body.decision.posture).toBe('auto');
      expect(body.decision.actionClass).toBe('nudge');
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockDeps).not.toHaveBeenCalled();
    });

    it('dispatches on ctx.role when no role arg is given', async () => {
      const res = await callTool({ action: 'improvements:capture' }, { role: 'overwatch' });
      const body = JSON.parse(res.content[0].text);
      expect(body.role).toBe('overwatch');
      expect(body.decision.posture).toBe('auto');
      expect(body.decision.actionClass).toBe('observe');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('GATES a structural action (escalate-only)', async () => {
      const res = await callTool({ action: 'processes:kill', role: 'overwatch' });
      const body = JSON.parse(res.content[0].text);
      expect(body.decision.posture).toBe('gated');
      expect(body.decision.escalateOnly).toBe(true);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('a non-overwatch role still uses the Queen decider', async () => {
      await callTool({ action: 'coord:send', role: 'queen' });
      expect(mockResolve).toHaveBeenCalledTimes(1);
    });
  });
});
