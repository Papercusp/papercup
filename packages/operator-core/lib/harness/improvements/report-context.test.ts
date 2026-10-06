/**
 * report-context.test.ts — the captured context block a filed bug carries
 * (unified-bug-pipeline-and-honest-queue-2026-10-05 P-010).
 */
import { describe, expect, it } from 'vitest';
import { REPORT_CONTEXT_LIMITS, buildReportContext } from './report-context';

const AT = '2026-10-06T16:00:00.000Z';
const DEFAULTS = { app: 'papercusp', appVersion: '0.9.0+abc123def456' };

describe('buildReportContext — what the reporter was looking at', () => {
  it('fills app and version from the serving build when the reporter sent none, and says so', () => {
    const ctx = buildReportContext({ defaults: DEFAULTS, capturedAt: AT });
    expect(ctx).toMatchObject({
      schemaVersion: 1,
      capturedAt: AT,
      app: 'papercusp',
      appVersion: '0.9.0+abc123def456',
      screen: null,
      recentErrors: [],
      logExcerpt: null,
      screenshot: null,
    });
    expect(ctx.autoCaptured).toEqual(['app', 'appVersion']);
  });

  it("keeps the reporter's own app, version and screen state (an installed desktop app can differ from the operator)", () => {
    const ctx = buildReportContext({
      input: {
        app: 'papercusp-desktop',
        appVersion: '1.4.2',
        screen: { url: '/work?tab=queue&item=EI-1', route: '/work', state: { tab: 'queue', item: 'EI-1' } },
        screenshot: { ref: 'attachment:report-77/screen.png' },
      },
      defaults: DEFAULTS,
      capturedAt: AT,
    });
    expect(ctx.app).toBe('papercusp-desktop');
    expect(ctx.appVersion).toBe('1.4.2');
    expect(ctx.screen).toEqual({ url: '/work?tab=queue&item=EI-1', route: '/work', state: { tab: 'queue', item: 'EI-1' } });
    expect(ctx.screenshot).toEqual({ ref: 'attachment:report-77/screen.png' });
    expect(ctx.autoCaptured).toEqual([]);
  });

  it("uses a watchdog's captured failing call as the recent error when the reporter sent none", () => {
    const ctx = buildReportContext({
      defaults: DEFAULTS,
      failure: { toolName: 'work_items:get', errorCode: 'timeout', message: 'no reply in 10000ms' },
      capturedAt: AT,
    });
    expect(ctx.recentErrors).toEqual([{ at: AT, source: 'work_items:get', message: 'work_items:get timeout: no reply in 10000ms' }]);
    expect(ctx.autoCaptured).toContain('recentErrors');
  });

  it("prefers the reporter's own recent errors over the failing call, keeping the most recent ones", () => {
    const errors = Array.from({ length: REPORT_CONTEXT_LIMITS.recentErrors + 3 }, (_, i) => ({ message: `err ${i}` }));
    const ctx = buildReportContext({
      input: { recentErrors: errors },
      defaults: DEFAULTS,
      failure: { toolName: 'x', message: 'ignored' },
      capturedAt: AT,
    });
    expect(ctx.recentErrors).toHaveLength(REPORT_CONTEXT_LIMITS.recentErrors);
    expect(ctx.recentErrors.at(-1)?.message).toBe(`err ${REPORT_CONTEXT_LIMITS.recentErrors + 2}`);
    expect(ctx.recentErrors[0].message).toBe('err 3');
    expect(ctx.truncated).toContain('recentErrors');
    expect(ctx.autoCaptured).not.toContain('recentErrors');
  });

  it('redacts secrets from the log excerpt and errors before they reach the work item', () => {
    const token = 'sk-' + 'A'.repeat(40);
    const ctx = buildReportContext({
      input: {
        logExcerpt: `request failed\npassword=hunter2hunter2 ${token}`,
        recentErrors: [{ message: `auth failed with ${token}` }],
      },
      defaults: DEFAULTS,
      capturedAt: AT,
    });
    expect(ctx.logExcerpt).toContain('request failed');
    expect(ctx.logExcerpt).not.toContain('hunter2hunter2');
    expect(ctx.logExcerpt).not.toContain(token);
    expect(ctx.recentErrors[0].message).not.toContain(token);
  });

  it('bounds an oversized log excerpt and URL and names what it cut', () => {
    const ctx = buildReportContext({
      input: { logExcerpt: 'x'.repeat(REPORT_CONTEXT_LIMITS.logExcerpt + 50), screen: { url: '/' + 'u'.repeat(5000) } },
      defaults: DEFAULTS,
      capturedAt: AT,
    });
    expect(ctx.logExcerpt).toHaveLength(REPORT_CONTEXT_LIMITS.logExcerpt);
    expect(ctx.screen?.url).toHaveLength(REPORT_CONTEXT_LIMITS.url);
    expect(ctx.truncated).toEqual(expect.arrayContaining(['logExcerpt', 'screen.url']));
  });

  it('refuses an inline screenshot and malformed fields without rejecting the filing', () => {
    const ctx = buildReportContext({
      input: { screenshot: 'data:image/png;base64,AAAA', screen: 'not-an-object', recentErrors: 'oops' },
      defaults: DEFAULTS,
      capturedAt: AT,
    });
    expect(ctx.screenshot).toBeNull();
    expect(ctx.screen).toBeNull();
    expect(ctx.recentErrors).toEqual([]);
    expect(ctx.refused).toEqual(expect.arrayContaining(['screenshot', 'screen', 'recentErrors']));
    expect(ctx.app).toBe('papercusp');
  });
});
