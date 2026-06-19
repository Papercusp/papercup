/**
 * agent-dispatch.test.ts — the agent.dispatch / agent.follow-up ⌘K commands
 * (start / continue a role-scoped agent chat over the agent-chats Hono endpoints).
 * Driven via the command registry (importing the module registers them; get(id)
 * retrieves the def). Pins the handler's OWN wiring, not the HTTP endpoint:
 *
 *  - the error classification: a failed create/follow-up throws a CommandError
 *    with code 'http-error' and `retryable = status >= 500` — 5xx retryable, 4xx
 *    NOT (a regression flipping the comparison silently mis-retries 404s or gives
 *    up on transient 503s).
 *  - the create-body shaping: role + feature_id + the title branch
 *    (`${role} · ${featureId}` when scoped, bare role otherwise).
 *  - dispatch fires the first message as a SECOND (fire-and-forget) POST after the
 *    chat is created — and a rejection of that POST must not surface (it's caught).
 *  - the base-URL precedence (INTERNAL_API_BASE wins) + slug URL-encoding.
 *
 * Mock-the-boundary pattern: global fetch is stubbed; CommandError + the registry
 * are real. Node env (the handler takes the server branch when window is absent).
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/commands/defs/agent-dispatch.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './agent-dispatch'; // side-effect: register(dispatch) + register(followUp)
import { get } from '../registry';
import { CommandError } from '../types';

const dispatch = get('agent.dispatch')!;
const followUp = get('agent.follow-up')!;

const okResp = (body: unknown = { id: 'chat-1' }) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResp = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
const savedBase = process.env.INTERNAL_API_BASE;
const savedOp = process.env.PAPERCUSP_OPERATOR_BASE;
const savedPort = process.env.PORT;

beforeEach(() => {
  // Deterministic fallback base: clear the precedence env so the URL is fixed.
  delete process.env.INTERNAL_API_BASE;
  delete process.env.PAPERCUSP_OPERATOR_BASE;
  delete process.env.PORT;
  fetchMock = vi.fn(async () => okResp());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.INTERNAL_API_BASE = savedBase;
  process.env.PAPERCUSP_OPERATOR_BASE = savedOp;
  process.env.PORT = savedPort;
});

const lastBody = (callIndex: number) =>
  JSON.parse((fetchMock.mock.calls[callIndex]![1] as RequestInit).body as string);

describe('agent.dispatch — success path', () => {
  it('creates the chat then fire-and-forget POSTs the first message; returns the chatId', async () => {
    const out = (await dispatch.handler(
      { slug: 'web', role: 'architect', message: 'hi there' },
      {} as never,
    )) as { ok: boolean; chatId: string; slug: string; role: string };
    expect(out).toEqual({ ok: true, chatId: 'chat-1', slug: 'web', role: 'architect' });
    // two fetches: [0] create chat, [1] first message
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/harness/web/agent-chats');
    expect(fetchMock.mock.calls[1]![0]).toContain('/agent-chats/chat-1/messages');
    expect(lastBody(1)).toEqual({ content: 'hi there' });
  });

  it('title is bare role with no featureId, and `role · F-id` when scoped', async () => {
    await dispatch.handler({ slug: 'web', role: 'worker', message: 'm' }, {} as never);
    expect(lastBody(0)).toMatchObject({ role: 'worker', title: 'worker' });

    fetchMock.mockClear();
    await dispatch.handler({ slug: 'web', role: 'worker', message: 'm', featureId: 'F-007' }, {} as never);
    expect(lastBody(0)).toMatchObject({ role: 'worker', feature_id: 'F-007', title: 'worker · F-007' });
  });

  it('URL-encodes the slug and honors INTERNAL_API_BASE precedence', async () => {
    process.env.INTERNAL_API_BASE = 'http://test-base:9999';
    await dispatch.handler({ slug: 'a b', role: 'r', message: 'm' }, {} as never);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://test-base:9999/api/harness/a%20b/agent-chats');
  });

  it('swallows a rejected first-message POST (fire-and-forget, does not reject the command)', async () => {
    fetchMock
      .mockResolvedValueOnce(okResp()) // create ok
      .mockRejectedValueOnce(new Error('network blip')); // message POST rejects
    await expect(
      dispatch.handler({ slug: 'web', role: 'architect', message: 'm' }, {} as never),
    ).resolves.toMatchObject({ ok: true, chatId: 'chat-1' });
  });
});

describe('agent.dispatch — error classification', () => {
  it('5xx create → CommandError http-error, retryable:true', async () => {
    fetchMock.mockResolvedValueOnce(errResp(503));
    try {
      await dispatch.handler({ slug: 'web', role: 'r', message: 'm' }, {} as never);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      expect((e as CommandError).payload).toMatchObject({ code: 'http-error', retryable: true });
      expect((e as CommandError).payload.message).toContain('503');
    }
  });

  it('4xx create → CommandError http-error, retryable:false (no second fetch)', async () => {
    fetchMock.mockResolvedValueOnce(errResp(404));
    await expect(
      dispatch.handler({ slug: 'web', role: 'r', message: 'm' }, {} as never),
    ).rejects.toMatchObject({ payload: { code: 'http-error', retryable: false } });
    expect(fetchMock).toHaveBeenCalledTimes(1); // bailed before the message POST
  });
});

describe('agent.follow-up', () => {
  it('appends a message and returns the chatId', async () => {
    const out = (await followUp.handler(
      { slug: 'web', chatId: 'c-9', message: 'more' },
      {} as never,
    )) as { ok: boolean; chatId: string };
    expect(out).toEqual({ ok: true, chatId: 'c-9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('/agent-chats/c-9/messages');
    expect(lastBody(0)).toEqual({ content: 'more' });
  });

  it('5xx → retryable:true, 4xx → retryable:false', async () => {
    fetchMock.mockResolvedValueOnce(errResp(500));
    await expect(
      followUp.handler({ slug: 'web', chatId: 'c', message: 'm' }, {} as never),
    ).rejects.toMatchObject({ payload: { code: 'http-error', retryable: true } });

    fetchMock.mockResolvedValueOnce(errResp(400));
    await expect(
      followUp.handler({ slug: 'web', chatId: 'c', message: 'm' }, {} as never),
    ).rejects.toMatchObject({ payload: { code: 'http-error', retryable: false } });
  });
});
