// @vitest-environment node
/**
 * harness-actions.ts — the /adv Harness-tab write helpers.
 *
 *  - `issueActionStatus` — verb → the IssueStatus it transitions to.
 *    acknowledge→acknowledged, close→closed, wontfix→wontfix; promote→null
 *    (the fix-feature it creates is server-side, not client-predictable).
 *  - `issueAction` — routes promote vs the rest to different endpoints and
 *    POSTs the right body. Mocked `fetch`, asserting URL + method + body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueActionStatus, issueAction, type IssueActionKind } from './harness-actions';

describe('issueActionStatus', () => {
  it('maps each non-promote verb to its target status', () => {
    expect(issueActionStatus('acknowledge')).toBe('acknowledged');
    expect(issueActionStatus('close')).toBe('closed');
    expect(issueActionStatus('wontfix')).toBe('wontfix');
  });

  it('returns null for promote (server creates the fix feature)', () => {
    expect(issueActionStatus('promote')).toBeNull();
  });
});

describe('issueAction', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function lastCall() {
    const mock = fetch as unknown as ReturnType<typeof vi.fn>;
    return mock.mock.calls.at(-1) as [string, RequestInit];
  }

  it('routes promote to /promote with an empty body', async () => {
    await issueAction('my-harness', 'ISS-1', 'promote');
    const [url, init] = lastCall();
    expect(url).toBe('/api/harness/my-harness/issues/ISS-1/promote');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('routes a status verb to /update with the mapped status in the body', async () => {
    await issueAction('my-harness', 'ISS-2', 'close');
    const [url, init] = lastCall();
    expect(url).toBe('/api/harness/my-harness/issues/ISS-2/update');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'closed' });
  });

  it.each<[IssueActionKind, string]>([
    ['acknowledge', 'acknowledged'],
    ['wontfix', 'wontfix'],
  ])('update body for %s carries status %s', async (action, status) => {
    await issueAction('h', 'ID', action);
    const [, init] = lastCall();
    expect(JSON.parse(init.body as string)).toEqual({ status });
  });

  it('URL-encodes the slug and the issue id', async () => {
    await issueAction('with space', 'a/b', 'acknowledge');
    const [url] = lastCall();
    expect(url).toBe('/api/harness/with%20space/issues/a%2Fb/update');
  });

  it('rejects when the server responds non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    await expect(issueAction('h', 'i', 'close')).rejects.toThrow('500: boom');
  });
});
