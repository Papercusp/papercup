// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOriginSchedulersForTests,
  getOriginScheduler,
} from '@papercusp/sync';
import {
  classifyOriginSchedulerFetch,
  installOriginSchedulerFetch,
  isIdempotentReadMethod,
} from './origin-scheduler-fetch';

const ORIGIN = 'http://127.0.0.1:3070';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(headers: Record<string, string> = {}): Response {
  return {
    headers: new Headers(headers),
  } as unknown as Response;
}

function stubWindow(fetchImpl: typeof fetch): void {
  vi.stubGlobal('window', {
    location: {
      href: `${ORIGIN}/adv`,
      origin: ORIGIN,
    },
    fetch: fetchImpl,
  });
}

afterEach(() => {
  _resetOriginSchedulersForTests();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  _resetOriginSchedulersForTests();
});

describe('classifyOriginSchedulerFetch', () => {
  it('classifies safe reads as foreground and mutations as interactive', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    expect(classifyOriginSchedulerFetch('/api/profile')).toMatchObject({
      schedule: true,
      origin: ORIGIN,
      requestClass: 'foreground-read',
      method: 'GET',
    });
    expect(
      classifyOriginSchedulerFetch('/api/profile', { method: 'POST' }),
    ).toMatchObject({
      schedule: true,
      requestClass: 'interactive-control',
      method: 'POST',
    });
  });

  it('leaves sync-owned, streaming, bulk, and foreign requests untouched', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    expect(classifyOriginSchedulerFetch('/api/zero-harness/rest-query')).toMatchObject({
      schedule: false,
      reason: 'sync-query',
    });
    expect(classifyOriginSchedulerFetch('/api/zero-harness/sse')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(
      classifyOriginSchedulerFetch('/api/agent-mcp/stream', {
        headers: { accept: 'text/event-stream' },
      }),
    ).toMatchObject({ schedule: false, reason: 'stream' });
    expect(
      classifyOriginSchedulerFetch('/api/files/download', {
        headers: { range: 'bytes=0-' },
      }),
    ).toMatchObject({ schedule: false, reason: 'stream' });
    expect(classifyOriginSchedulerFetch('https://external.example/api/x')).toMatchObject({
      schedule: false,
      reason: 'not-operator-api',
    });
  });

  it('keeps the retry boundary limited to GET and HEAD', () => {
    expect(isIdempotentReadMethod('GET')).toBe(true);
    expect(isIdempotentReadMethod('HEAD')).toBe(true);
    expect(isIdempotentReadMethod('OPTIONS')).toBe(false);
    expect(isIdempotentReadMethod('POST')).toBe(false);
    expect(isIdempotentReadMethod('DELETE')).toBe(false);
  });
});

describe('installOriginSchedulerFetch', () => {
  it('shares one origin-wide queue across raw fetch callers', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response({ 'content-length': '12', 'x-papercusp-protocol': 'h1' });
    });
    stubWindow(inner as unknown as typeof fetch);
    const scheduler = getOriginScheduler(ORIGIN, {
      limit: 1,
      reservedInteractive: 0,
      requestTimeoutMs: 1_000,
    });
    const handle = installOriginSchedulerFetch();
    expect(handle).not.toBeNull();

    const first = window.fetch('/api/first');
    await tick();
    const second = window.fetch('/api/second');
    await tick();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot()).toMatchObject({ inFlight: 1, queued: 1 });

    hold.resolve();
    await Promise.all([first, second]);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot().byClass['foreground-read']).toMatchObject({
      admitted: 2,
      completed: 2,
      bytes: 24,
    });
    handle?.uninstall();
  });

  it('runs an interactive mutation ahead of queued foreground reads', async () => {
    const hold = deferred<void>();
    const calls: string[] = [];
    const inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (calls.length === 1) await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/read-1');
    await tick();
    const second = window.fetch('/api/read-2');
    const mutation = window.fetch('/api/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await tick();
    hold.resolve();
    await Promise.all([first, second, mutation]);

    expect(calls).toEqual(['GET /api/read-1', 'POST /api/mutate', 'GET /api/read-2']);
    handle?.uninstall();
  });

  it('cancels a queued caller before it reaches the underlying IPC/native fetch', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/holding');
    await tick();
    const controller = new AbortController();
    const queued = window.fetch('/api/unmounted', { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(queued).rejects.toBeDefined();
    expect(inner).toHaveBeenCalledTimes(1);

    hold.resolve();
    await first;
    handle?.uninstall();
  });

  it('preserves the captured transport and never replays an unsafe write', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new TypeError('ambiguous transport failure');
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 1, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    await expect(
      window.fetch('/api/lifecycle', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('ambiguous transport failure');
    expect(inner).toHaveBeenCalledTimes(1);
    handle?.uninstall();
  });

  it('is idempotent and bypasses explicitly-owned paths without nesting', async () => {
    const inner = vi.fn(async () => response());
    stubWindow(inner as unknown as typeof fetch);
    const first = installOriginSchedulerFetch();
    const second = installOriginSchedulerFetch();
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await window.fetch('/api/zero-harness/rest-query');
    await window.fetch('/api/zero-harness/sse');
    await window.fetch('/assets/app.js');
    await window.fetch('https://external.example/api/x');
    expect(inner).toHaveBeenCalledTimes(4);
    first?.uninstall();
  });
});

