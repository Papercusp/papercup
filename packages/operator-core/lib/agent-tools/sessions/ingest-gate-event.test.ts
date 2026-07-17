import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-asker', ownerLabel: 'su · asker', workspaceId: 'ws-1' })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-fallback' }));

const openOrTouchGate = vi.fn();
const closeGate = vi.fn();
vi.mock('../../attention/gate-store', () => ({
  openOrTouchGate: (...a: unknown[]) => openOrTouchGate(...a),
  closeGate: (...a: unknown[]) => closeGate(...a),
}));

const tool = (await import('./ingest-gate-event')).default;

function callTool(args: Record<string, unknown>) {
  return (tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: Record<string, unknown> }> }).handler(
    args,
    {},
  );
}

describe('sessions:ingest-gate-event', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens a fresh ask gate, tagging the asker ownerId from identity when not passed', async () => {
    openOrTouchGate.mockResolvedValue({ id: '42', outcome: 'opened' });
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'ask', refId: 'ref-1', question: 'Q?' });
    expect(res.data).toEqual({ ok: true, gateId: '42', state: 'opened' });
    expect(openOrTouchGate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', sessionId: 's1', kind: 'ask', refId: 'ref-1', ownerId: 'su-asker', question: 'Q?' }),
    );
  });

  it('falls back to text when question is omitted', async () => {
    openOrTouchGate.mockResolvedValue({ id: '43', outcome: 'already_open' });
    const res = await callTool({ sessionId: 's1', client: 'omp', kind: 'permission_wait', refId: 'ref-2', text: 'blocked on approval' });
    expect(res.data.state).toBe('already_open');
    expect(openOrTouchGate).toHaveBeenCalledWith(expect.objectContaining({ question: 'blocked on approval', client: 'omp', kind: 'permission_wait' }));
  });

  it('an explicit ownerId overrides the identity-derived one', async () => {
    openOrTouchGate.mockResolvedValue({ id: '44', outcome: 'opened' });
    await callTool({ sessionId: 's1', client: 'claude', kind: 'ask', refId: 'ref-3', ownerId: 'su-explicit' });
    expect(openOrTouchGate).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-explicit' }));
  });

  it("kind:'cleared' closes by refId instead of opening", async () => {
    closeGate.mockResolvedValue('closed');
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'cleared', refId: 'ref-1' });
    expect(closeGate).toHaveBeenCalledWith({ workspaceId: 'ws-1', sessionId: 's1', refId: 'ref-1', reason: 'hook_cleared' });
    expect(openOrTouchGate).not.toHaveBeenCalled();
    expect(res.data).toEqual({ ok: true, gateId: null, state: 'closed' });
  });

  it("kind:'cleared' on an unknown ref reports not_found", async () => {
    closeGate.mockResolvedValue('not_found');
    const res = await callTool({ sessionId: 's1', client: 'claude', kind: 'cleared', refId: 'ref-missing' });
    expect(res.data.state).toBe('not_found');
  });
});
