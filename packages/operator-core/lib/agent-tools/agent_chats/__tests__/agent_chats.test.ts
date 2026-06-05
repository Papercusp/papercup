/**
 * agent_chats:* — list/get/create/archive.
 *
 * Tools delegate to lib/agent-chats-data; tests vi.doMock the lib and
 * assert the tool's projection of the lib result.
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

const listChatsMock = vi.fn();
const getChatMock = vi.fn();
const createChatMock = vi.fn();
const archiveChatMock = vi.fn();

let listTool: { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };
let getTool: typeof listTool;
let createTool: typeof listTool;
let archiveTool: typeof listTool;

beforeAll(async () => {
  vi.doMock('../../../agent-chats-data', () => ({
    listChats: listChatsMock,
    getChat: getChatMock,
    createChat: createChatMock,
    archiveChat: archiveChatMock,
  }));

  listTool = (await import('../list')).default as never;
  getTool = (await import('../get')).default as never;
  createTool = (await import('../create')).default as never;
  archiveTool = (await import('../archive')).default as never;
});

afterAll(() => {
  vi.doUnmock('../../../agent-chats-data');
});

describe('agent_chats:list', () => {
  it('returns count + chats from lib', async () => {
    listChatsMock.mockResolvedValueOnce({
      ok: true,
      data: { chats: [{ id: 'c1' }, { id: 'c2' }] },
    });
    const result = await listTool.handler({ slug: 'sheets' }, MAKE_CTX());
    expect(listChatsMock).toHaveBeenCalledWith({ slug: 'sheets' });
    const payload = parsePayload(result);
    expect(payload).toEqual({ count: 2, chats: [{ id: 'c1' }, { id: 'c2' }] });
  });

  it('passes includeArchived through', async () => {
    listChatsMock.mockResolvedValueOnce({ ok: true, data: { chats: [] } });
    await listTool.handler({ slug: 'sheets', includeArchived: true }, MAKE_CTX());
    expect(listChatsMock).toHaveBeenLastCalledWith({ slug: 'sheets', includeArchived: true });
  });

  it('surfaces lib error', async () => {
    listChatsMock.mockResolvedValueOnce({ ok: false, status: 500, error: 'pg down' });
    const result = await listTool.handler({ slug: 'sheets' }, MAKE_CTX());
    expect(parsePayload(result)).toEqual({ error: 'pg down' });
  });
});

describe('agent_chats:get', () => {
  it('passes through chat data', async () => {
    const chat = {
      id: 'c1',
      role: 'architect',
      feature_id: 'F-001',
      title: null,
      transcript: [],
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd_cents: 0,
      created_at: 'now',
      updated_at: 'now',
      archived_at: null,
      feature_lock: null,
    };
    getChatMock.mockResolvedValueOnce({ ok: true, data: chat });
    const result = await getTool.handler({ slug: 'sheets', chatId: 'c1' }, MAKE_CTX());
    expect(parsePayload(result)).toEqual(chat);
  });

  it('returns error envelope on 404', async () => {
    getChatMock.mockResolvedValueOnce({ ok: false, status: 404, error: 'chat not found' });
    const result = await getTool.handler({ slug: 'sheets', chatId: 'missing' }, MAKE_CTX());
    expect(parsePayload(result)).toEqual({ error: 'chat not found' });
  });
});

describe('agent_chats:create', () => {
  it('creates and returns chat data', async () => {
    const chat = {
      id: 'new-id',
      role: 'worker',
      feature_id: 'F-001',
      title: 'worker · F-001',
      transcript: [],
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd_cents: 0,
      created_at: 'now',
      updated_at: 'now',
      archived_at: null,
      feature_lock: null,
    };
    createChatMock.mockResolvedValueOnce({ ok: true, data: chat });
    const result = await createTool.handler(
      { slug: 'sheets', role: 'worker', feature_id: 'F-001' },
      MAKE_CTX(),
    );
    expect(createChatMock).toHaveBeenCalledWith({
      slug: 'sheets',
      role: 'worker',
      feature_id: 'F-001',
    });
    expect(parsePayload(result)).toEqual(chat);
  });

  it('surfaces validation error', async () => {
    createChatMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'role must be one of: ...',
    });
    const result = await createTool.handler(
      { slug: 'sheets', role: 'bogus' },
      MAKE_CTX(),
    );
    expect((parsePayload(result) as { error: string }).error).toMatch(/role must be/);
  });
});

describe('agent_chats:archive', () => {
  it('returns ok on success', async () => {
    archiveChatMock.mockResolvedValueOnce({ ok: true, data: { ok: true } });
    const result = await archiveTool.handler(
      { slug: 'sheets', chatId: 'c1' },
      MAKE_CTX(),
    );
    expect(parsePayload(result)).toEqual({ ok: true });
  });

  it('surfaces lib error', async () => {
    archiveChatMock.mockResolvedValueOnce({ ok: false, status: 500, error: 'archive failed' });
    const result = await archiveTool.handler(
      { slug: 'sheets', chatId: 'c1' },
      MAKE_CTX(),
    );
    expect(parsePayload(result)).toEqual({ error: 'archive failed' });
  });
});
