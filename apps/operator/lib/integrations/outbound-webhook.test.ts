/**
 * outbound-webhook — postDiscordWebhook retry policy + buildDiscordPayload.
 *
 * The pure helpers (discord-webhook-types) run for real; only global fetch is
 * mocked. Backoff sleeps are driven with fake timers via runAllTimersAsync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postDiscordWebhook, buildDiscordPayload } from './outbound-webhook';

const URL_OK = 'https://discord.com/api/webhooks/123456/AbC-_token';
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 204/304 forbid a body; use a null body for all so the Response ctor is happy.
const resp = (status: number) => new Response(null, { status });

describe('postDiscordWebhook', () => {
  it('rejects an invalid webhook URL without calling fetch', async () => {
    const res = await postDiscordWebhook({ webhookUrl: 'https://evil.example.com/x', payload: { content: 'hi' } });
    expect(res).toEqual({ ok: false, reason: 'invalid_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty payload (no content or embeds) before posting', async () => {
    const res = await postDiscordWebhook({ webhookUrl: URL_OK, payload: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('invalid_payload');
      expect(res.detail).toBe('no_content_or_embeds');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok on a 2xx response', async () => {
    fetchMock.mockResolvedValue(resp(204));
    const res = await postDiscordWebhook({ webhookUrl: URL_OK, payload: { content: 'hi' } });
    expect(res).toEqual({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-retryable 4xx — returns http_error after one attempt', async () => {
    fetchMock.mockResolvedValue(resp(400));
    const res = await postDiscordWebhook({ webhookUrl: URL_OK, payload: { content: 'hi' } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('http_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx up to the cap then gives up (max_retries_exceeded), 4 attempts total', async () => {
    fetchMock.mockResolvedValue(resp(503));
    const p = postDiscordWebhook({ webhookUrl: URL_OK, payload: { content: 'hi' } });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('max_retries_exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(4); // attempt 0 + 3 retries
  });

  it('recovers when a 5xx is followed by a 2xx', async () => {
    fetchMock.mockResolvedValueOnce(resp(502)).mockResolvedValueOnce(resp(200));
    const p = postDiscordWebhook({ webhookUrl: URL_OK, payload: { content: 'hi' } });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient network error and then succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(resp(200));
    const p = postDiscordWebhook({ webhookUrl: URL_OK, payload: { content: 'hi' } });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('buildDiscordPayload', () => {
  it('feature_filed → blue embed with the feature id + harness footer', () => {
    const p = buildDiscordPayload({ kind: 'feature_filed', harnessSlug: 'sheets', featureId: 'F-7', title: 'Add export' });
    expect(p.embeds?.[0].title).toContain('F-7');
    expect(p.embeds?.[0].description).toBe('Add export');
    expect(p.embeds?.[0].footer?.text).toBe('sheets');
  });

  it('pr_opened / pr_merged carry the PR number, url, and auto marker', () => {
    const opened = buildDiscordPayload({ kind: 'pr_opened', harnessSlug: 'h', prNumber: 42, title: 'T', author: 'a', htmlUrl: 'https://gh/pr/42' });
    expect(opened.embeds?.[0].title).toContain('#42');
    expect(opened.embeds?.[0].url).toBe('https://gh/pr/42');
    const merged = buildDiscordPayload({ kind: 'pr_merged', harnessSlug: 'h', prNumber: 42, title: 'T', author: 'a', htmlUrl: 'https://gh/pr/42', auto: true });
    expect(merged.embeds?.[0].title).toContain('(auto)');
  });

  it('escalation → yellow embed with the summary', () => {
    const p = buildDiscordPayload({ kind: 'escalation', harnessSlug: 'h', featureId: 'F-1', summary: 'rebase conflict' });
    expect(p.embeds?.[0].title).toContain('F-1');
    expect(p.embeds?.[0].description).toBe('rebase conflict');
  });
});
