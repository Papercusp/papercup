import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  redactedRenderCrash, reportRenderCrash, resetRenderCrashReportDedupForTest,
} from './render-crash-report';

afterEach(() => {
  vi.unstubAllGlobals();
  resetRenderCrashReportDedupForTest();
});

describe('render crash capture', () => {
  it('sends only a bounded classification and suppresses duplicate reports per page', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const error = new TypeError('secret-token=abc in https://example.invalid/private');
    error.stack = 'private stack with secret-token=abc';
    const componentStack = '    at LearningTab (https://example.invalid/?secret-token=abc)';
    reportRenderCrash('adv-tab', error, componentStack, 'learning');
    reportRenderCrash('adv-tab', error, componentStack, 'learning');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/desktop/telemetry-report');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      kind: 'crash',
      payload: {
        source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
        component: 'LearningTab', tab: 'learning',
        fingerprint: 'adv-tab:TypeError:LearningTab:learning',
      },
    });
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(JSON.stringify(body)).not.toContain('https://');
  });

  it('drops arbitrary error names, component paths, and tab text', () => {
    const error = new Error('user data');
    error.name = 'privateKey=abc';
    expect(redactedRenderCrash('adv-tab', error, 'at /private/file.tsx', 'tab?secret=abc')).toEqual({
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'Error',
      component: 'unknown', tab: 'other',
      fingerprint: 'adv-tab:Error:unknown:other',
    });
  });
});
