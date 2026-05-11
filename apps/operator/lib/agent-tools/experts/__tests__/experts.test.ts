/**
 * experts:* read tools — list/get/spec_get/feedback_list/roles/chat_agents.
 *
 * Tools delegate to lib/experts-data; tests vi.doMock the lib and assert
 * the tool's projection of the lib result.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const listExpertsMock = vi.fn();
const getExpertMock = vi.fn();
const getExpertSpecMock = vi.fn();
const listExpertFeedbackMock = vi.fn();
const listExpertRolesMock = vi.fn();
const listChatAgentsMock = vi.fn();

let listTool: { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
let getTool: typeof listTool;
let specTool: typeof listTool;
let feedbackTool: typeof listTool;
let rolesTool: typeof listTool;
let chatAgentsTool: typeof listTool;

beforeAll(async () => {
  vi.doMock('@/lib/experts-data', () => ({
    listExperts: listExpertsMock,
    getExpert: getExpertMock,
    getExpertSpec: getExpertSpecMock,
    listExpertFeedback: listExpertFeedbackMock,
    listExpertRoles: listExpertRolesMock,
    listChatAgents: listChatAgentsMock,
  }));

  listTool = (await import('@/lib/agent-tools/experts/list')).default as never;
  getTool = (await import('@/lib/agent-tools/experts/get')).default as never;
  specTool = (await import('@/lib/agent-tools/experts/spec_get')).default as never;
  feedbackTool = (await import('@/lib/agent-tools/experts/feedback_list')).default as never;
  rolesTool = (await import('@/lib/agent-tools/experts/roles')).default as never;
  chatAgentsTool = (await import('@/lib/agent-tools/experts/chat_agents')).default as never;
});

afterAll(() => {
  vi.doUnmock('@/lib/experts-data');
});

describe('experts:list', () => {
  it('returns count + experts', async () => {
    listExpertsMock.mockResolvedValueOnce({
      ok: true,
      data: { experts: [{ id: 'EXP-001' }, { id: 'EXP-002' }] },
    });
    const result = await listTool.handler({ slug: 'sheets' }, MAKE_CTX());
    expect(listExpertsMock).toHaveBeenCalledWith('sheets');
    expect(parsePayload(result)).toEqual({
      count: 2,
      experts: [{ id: 'EXP-001' }, { id: 'EXP-002' }],
    });
  });

  it('surfaces unknown harness', async () => {
    listExpertsMock.mockResolvedValueOnce({ ok: false, status: 404, error: 'unknown harness' });
    const result = await listTool.handler({ slug: 'nope' }, MAKE_CTX());
    expect(parsePayload(result)).toEqual({ error: 'unknown harness' });
  });
});

describe('experts:get', () => {
  it('returns the expert detail verbatim', async () => {
    const data = {
      id: 'EXP-001',
      title: 'X',
      slug: 'sheets',
      status: 'active',
      budgetCents: 100,
      featureSize: 'standard',
      highLevelSpec: 'do thing',
      agentCount: 1,
      roundCount: 0,
      personasUsed: [],
      userEngaged: false,
      createdAt: 'now',
      updatedAt: 'now',
      specPath: '/.harness/experts/EXP-001/SPEC.md',
      spec: 'content',
      spentCents: 7,
      nextAction: 'agent',
    };
    getExpertMock.mockResolvedValueOnce({ ok: true, data });
    const result = await getTool.handler(
      { slug: 'sheets', expertId: 'EXP-001' },
      MAKE_CTX(),
    );
    expect(parsePayload(result)).toEqual(data);
  });

  it('surfaces invalid expert id error', async () => {
    getExpertMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'invalid expert id',
    });
    const result = await getTool.handler(
      { slug: 'sheets', expertId: 'bad' },
      MAKE_CTX(),
    );
    expect(parsePayload(result)).toEqual({ error: 'invalid expert id' });
  });
});

describe('experts:spec_get', () => {
  it('returns content', async () => {
    getExpertSpecMock.mockResolvedValueOnce({
      ok: true,
      data: { content: '# spec' },
    });
    const result = await specTool.handler(
      { slug: 'sheets', expertId: 'EXP-001' },
      MAKE_CTX(),
    );
    expect(parsePayload(result)).toEqual({ content: '# spec' });
  });
});

describe('experts:feedback_list', () => {
  it('returns count + feedback', async () => {
    listExpertFeedbackMock.mockResolvedValueOnce({
      ok: true,
      data: {
        feedback: [
          { id: '1', persona: 'a', ended: false, verdict: null },
          { id: '2', persona: 'b', ended: true, verdict: { approved: true } },
        ],
      },
    });
    const result = await feedbackTool.handler(
      { slug: 'sheets', expertId: 'EXP-001' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result) as {
      count: number;
      feedback: Array<{ ended: boolean }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.feedback[1].ended).toBe(true);
  });
});

describe('experts:roles', () => {
  it('returns count + roles', async () => {
    listExpertRolesMock.mockResolvedValueOnce({
      ok: true,
      data: { roles: [{ id: 'security-reviewer' }, { id: 'perf-auditor' }] },
    });
    const result = await rolesTool.handler({ slug: 'sheets' }, MAKE_CTX());
    expect((parsePayload(result) as { count: number }).count).toBe(2);
  });
});

describe('experts:chat_agents', () => {
  it('returns static roles + instanced experts', async () => {
    listChatAgentsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        agents: [
          { role: 'worker' },
          { role: 'architect' },
          { role: 'expert', instanceId: 'EXP-001', title: 'X', status: 'active' },
        ],
      },
    });
    const result = await chatAgentsTool.handler({ slug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result) as {
      count: number;
      agents: Array<{ role: string }>;
    };
    expect(payload.count).toBe(3);
    expect(payload.agents.filter((a) => a.role === 'expert')).toHaveLength(1);
  });
});
