/**
 * working-set-actions.test.ts — P-038 write-path wrappers (setWorkingActive /
 * clearWorkingActive). Thin POSTs over the working-set.ts endpoints (which are
 * themselves tested); here we pin the URL + body the live shell sends.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWorkingActive, clearWorkingActive } from '../harness-actions';

function mockFetchOk() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('working-set write actions', () => {
  it('setWorkingActive POSTs the github_user_id to set-active', async () => {
    const calls = mockFetchOk();
    await setWorkingActive('my-harness', 'F-12', 1567022);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/harness/my-harness/working-set/F-12/set-active');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ github_user_id: 1567022 });
  });

  it('clearWorkingActive POSTs the github_user_id to clear-active', async () => {
    const calls = mockFetchOk();
    await clearWorkingActive('my-harness', 'F-12', 1567022);
    expect(calls[0].url).toBe('/api/harness/my-harness/working-set/F-12/clear-active');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ github_user_id: 1567022 });
  });

  it('url-encodes slug + feature id', async () => {
    const calls = mockFetchOk();
    await setWorkingActive('a/b', 'F 1', 7);
    expect(calls[0].url).toBe('/api/harness/a%2Fb/working-set/F%201/set-active');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(setWorkingActive('h', 'F-1', 7)).rejects.toThrow();
  });
});
