import { beforeEach, describe, expect, it, vi } from 'vitest';

const budgetMocks = vi.hoisted(() => ({
  checkBudget: vi.fn(),
  shouldBypassOperatorBudget: vi.fn((uiClientId?: string | null) =>
    typeof uiClientId === 'string' && uiClientId.startsWith('llm-testing/')),
}));

vi.mock('@papercusp/sse', () => ({
  sseResponse: vi.fn(() => new Response('stream-started', { status: 200 })),
}));

vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (def: unknown) => def,
  dispatchProjectedToolStream: vi.fn(async function* () {}),
  emitToSseSink: vi.fn(),
  lookupByMcpName: vi.fn(() => ({ name: 'operator:converse' })),
  subscribeWorkspace: vi.fn(() => () => {}),
}));

vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
}));
vi.mock('../../../operator-budget', () => ({
  checkBudget: budgetMocks.checkBudget,
  shouldBypassOperatorBudget: budgetMocks.shouldBypassOperatorBudget,
}));

import { sseResponse } from '@papercusp/sse';
import route from './operator-converse';

const handler = (body: unknown) =>
  (route as { handler: (req: Request) => Promise<Response> }).handler(
    new Request('http://localhost/api/agent-mcp/operator-converse', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  budgetMocks.checkBudget.mockResolvedValue({
    state: { dailyCapUsd: 5, spend: [] },
    exceeded: true,
    todaySpendUsd: 5.5,
    capUsd: 5,
  } as never);
});

describe('operator-converse route budget preflight', () => {
  it('keeps the owner-facing daily budget gate for normal clients', async () => {
    const res = await handler({ messages: [], uiClientId: 'desktop-client' });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain('Papercup daily budget reached');
    expect(budgetMocks.shouldBypassOperatorBudget).toHaveBeenCalledWith('desktop-client');
    expect(budgetMocks.checkBudget).toHaveBeenCalledTimes(1);
    expect(sseResponse).not.toHaveBeenCalled();
  });

  it('lets LLM scenario runs bypass the owner-facing daily budget gate', async () => {
    const res = await handler({
      messages: [],
      uiClientId: 'llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('stream-started');
    expect(budgetMocks.shouldBypassOperatorBudget).toHaveBeenCalledWith('llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(budgetMocks.checkBudget).not.toHaveBeenCalled();
    expect(sseResponse).toHaveBeenCalledTimes(1);
  });
});
