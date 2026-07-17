import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-reader', ownerLabel: 'su · reader', workspaceId: 'ws-1' })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-fallback' }));

const listPendingGates = vi.fn();
vi.mock('../../attention/gate-store', () => ({
  listPendingGates: (...a: unknown[]) => listPendingGates(...a),
}));

const tool = (await import('./list-pending-gates')).default;

function callTool(args: Record<string, unknown>) {
  return (tool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ data: Record<string, unknown> }> }).handler(
    args,
    {},
  );
}

describe('sessions:list-pending-gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps store rows to the compact wire shape', async () => {
    listPendingGates.mockResolvedValue([
      {
        id: '1',
        workspace_id: 'ws-1',
        session_id: 's1',
        client: 'claude',
        kind: 'ask',
        ref_id: 'ref-1',
        owner_id: 'su-asker',
        question: 'Q?',
        options: [{ label: 'yes' }],
        source: 'watcher',
        raw_ref: '/x.jsonl',
        harness_slug: null,
        opened_at: '2026-07-17T09:00:00.000Z',
        closed_at: null,
        closed_reason: null,
        created_at: '2026-07-17T09:00:00.000Z',
      },
    ]);
    const res = await callTool({ sessionId: 's1' });
    expect(listPendingGates).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', sessionId: 's1' }),
    );
    expect(res.data).toEqual({
      ok: true,
      count: 1,
      gates: [
        {
          id: '1',
          sessionId: 's1',
          client: 'claude',
          kind: 'ask',
          question: 'Q?',
          options: [{ label: 'yes' }],
          ownerId: 'su-asker',
          source: 'watcher',
          openedAt: '2026-07-17T09:00:00.000Z',
          closedAt: null,
          closedReason: null,
        },
      ],
    });
  });

  it('passes through order/limit/includeClosed', async () => {
    listPendingGates.mockResolvedValue([]);
    await callTool({ order: 'newest', limit: 5, includeClosed: true });
    expect(listPendingGates).toHaveBeenCalledWith(
      expect.objectContaining({ order: 'newest', limit: 5, includeClosed: true }),
    );
  });
});
