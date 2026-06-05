import { describe, expect, it, vi } from 'vitest';

import {
  askOperatorViaConverse,
  normalizeTrigger,
  ASK_OPERATOR_TIMEOUT_MS,
} from './device-ask-operator';

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const evt of events) controller.enqueue(enc.encode(evt + '\n\n'));
      controller.close();
    },
  });
}

function fakeFetch(body: ReadableStream<Uint8Array> | null, init: Partial<Response> = {}): typeof fetch {
  return async () => {
    return new Response(body, { status: init.status ?? 200 }) as unknown as Response;
  };
}

describe('normalizeTrigger', () => {
  it('passes through known triggers', () => {
    expect(normalizeTrigger('user_message')).toBe('user_message');
    expect(normalizeTrigger('open_canvas')).toBe('open_canvas');
    expect(normalizeTrigger('user_says_ready')).toBe('user_says_ready');
  });
  it('collapses retired silence_* triggers to user_message (2026-05-14)', () => {
    expect(normalizeTrigger('silence_nudge')).toBe('user_message');
    expect(normalizeTrigger('silence_check')).toBe('user_message');
    expect(normalizeTrigger('silence_after_question')).toBe('user_message');
  });
  it('falls back to user_message for unknown / non-string', () => {
    expect(normalizeTrigger('garbage')).toBe('user_message');
    expect(normalizeTrigger(null)).toBe('user_message');
    expect(normalizeTrigger(undefined)).toBe('user_message');
    expect(normalizeTrigger(42)).toBe('user_message');
  });
});

describe('askOperatorViaConverse', () => {
  it('returns ok with assembled text when stream emits text_delta events', async () => {
    const fetcher = fakeFetch(
      sseStream([
        'data: {"text":"Hello "}',
        'data: {"text":"world."}',
      ]),
    );
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'hi',
      trigger: 'user_message',
      fetcher,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.text).toBe('Hello world.');
  });

  it('strips <say> tag when present', async () => {
    const fetcher = fakeFetch(
      sseStream([
        'data: {"text":"<say>Spoken part</say>"}',
      ]),
    );
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'hi',
      trigger: 'user_message',
      fetcher,
    });
    if (result.kind === 'ok') expect(result.text).toBe('Spoken part');
  });

  it('returns empty kind when stream has no text payload', async () => {
    const fetcher = fakeFetch(
      sseStream([
        'data: {"event":"result","cost":0.001}',
      ]),
    );
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'what time is it',
      trigger: 'user_message',
      fetcher,
    });
    expect(result.kind).toBe('empty');
    if (result.kind === 'empty') {
      expect(result.text).toMatch(/empty response/);
      expect(result.eventCount).toBe(1);
      expect(result.trigger).toBe('user_message');
    }
  });

  it('returns bad-status when converse returns 5xx', async () => {
    const fetcher = fakeFetch(sseStream([]), { status: 503 });
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'hi',
      trigger: 'user_message',
      fetcher,
    });
    // sseStream with empty events is still a body, so status==503 with body
    // routes to bad-status when !res.ok.
    expect(result.kind).toBe('bad-status');
    if (result.kind === 'bad-status') {
      expect(result.status).toBe(503);
      expect(result.text).toMatch(/Papercup is offline/);
    }
  });

  it('returns timeout kind when fetch is aborted', async () => {
    // Fetcher that never resolves until aborted.
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      const sig = (init as RequestInit | undefined)?.signal;
      sig?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'hi',
      trigger: 'user_message',
      fetcher,
      timeoutMs: 30,
    });
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.text).toMatch(/took longer/);
      expect(result.timeoutMs).toBe(30);
    }
  });

  it('returns error kind for non-abort failures', async () => {
    const fetcher: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3055');
    };
    const result = await askOperatorViaConverse({
      baseUrl: 'http://localhost:3055',
      userText: 'hi',
      trigger: 'user_message',
      fetcher,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.text).toMatch(/Hit an error/);
      expect(result.error).toContain('ECONNREFUSED');
    }
  });
});

describe('ASK_OPERATOR_TIMEOUT_MS', () => {
  it('is bounded but generous (between 10s and 60s)', () => {
    expect(ASK_OPERATOR_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(ASK_OPERATOR_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
