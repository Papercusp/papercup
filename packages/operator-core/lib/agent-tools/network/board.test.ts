/**
 * network:board tool-wrapper tests (NB2, hive-network-surface-2026-06-11 C-3).
 *
 * The wrapper is thin: it resolves the workspace id through a 4-level fallback
 * (args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ??
 * activeWorkspaceId()), calls buildNetworkBoard with it, and serializes the
 * rows into an `{ ok, count, rows }` envelope as one text content part.
 *
 * buildNetworkBoard + activeWorkspaceId are mocked at their module boundary so
 * this pins the wrapper's OWN behavior — the precedence order (each level wins
 * only when every higher-priority source is absent) + the envelope shape — with
 * no PG/fleet/directory IO. The composition itself is covered by
 * build-board.test.ts / build-board-io.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildNetworkBoard = vi.fn(async () => [] as unknown[]);
vi.mock('../../network-board/build-board', () => ({
  buildNetworkBoard: (...a: unknown[]) => buildNetworkBoard(...a),
}));

const activeWorkspaceId = vi.fn(() => 'active-ws');
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => activeWorkspaceId(),
}));

import tool from './board';

function envelopeOf(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text);
}
/** The workspaceId buildNetworkBoard was called with. */
function calledWorkspace() {
  return (buildNetworkBoard.mock.calls[0]?.[0] as { workspaceId?: string })?.workspaceId;
}

beforeEach(() => {
  buildNetworkBoard.mockClear();
  buildNetworkBoard.mockResolvedValue([]);
  activeWorkspaceId.mockClear();
  activeWorkspaceId.mockReturnValue('active-ws');
});
afterEach(() => vi.restoreAllMocks());

describe('network:board — workspace fallback precedence', () => {
  it('args.workspace wins over every ctx source', async () => {
    await tool.handler(
      { workspace: 'arg-ws' },
      { workspaceId: 'ctx-ws', principal: { workspaceId: 'principal-ws' } } as never,
    );
    expect(calledWorkspace()).toBe('arg-ws');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
  });

  it('ctx.workspaceId wins when args.workspace is absent', async () => {
    await tool.handler(
      {},
      { workspaceId: 'ctx-ws', principal: { workspaceId: 'principal-ws' } } as never,
    );
    expect(calledWorkspace()).toBe('ctx-ws');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
  });

  it('ctx.principal.workspaceId wins when arg + ctx.workspaceId are absent', async () => {
    await tool.handler({}, { principal: { workspaceId: 'principal-ws' } } as never);
    expect(calledWorkspace()).toBe('principal-ws');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
  });

  it('activeWorkspaceId() is the final fallback when nothing else resolves', async () => {
    await tool.handler({}, {} as never);
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(calledWorkspace()).toBe('active-ws');
  });
});

describe('network:board — envelope', () => {
  it('wraps rows as { ok:true, count, rows } in one text part', async () => {
    const rows = [
      { tier: 1, key: 'home', title: 'home', trust: 'local' },
      { tier: 4, key: 'pk', title: 'peer', trust: 'gossip' },
    ];
    buildNetworkBoard.mockResolvedValueOnce(rows);
    const res = await tool.handler({}, { workspaceId: 'ws' } as never);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    const env = envelopeOf(res);
    expect(env).toEqual({ ok: true, count: 2, rows });
  });

  it('count is 0 with an empty rows array when the board is empty', async () => {
    buildNetworkBoard.mockResolvedValueOnce([]);
    const env = envelopeOf(await tool.handler({}, { workspaceId: 'ws' } as never));
    expect(env).toEqual({ ok: true, count: 0, rows: [] });
  });
});
