import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const authority = vi.hoisted(() => ({ allowed: true, host: 'https://posthog.example.test', projectKey: 'capture-secret' }));
vi.mock('./runtime', () => ({ runtimeTraceDeliveryConfig: async () => ({ ...authority, distinctId: 'local-install' }) }));
vi.mock('../posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: {
  host: 'https://posthog.example.test', projectKey: 'capture-secret', personalApiKey: 'query-secret',
} }) }));
import { readConfiguredTraceProject } from './project-readback';

const trace = '12345678901234567890123456789012';
const span = '1234567890123456';
const request = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  authority.allowed = true; authority.host = 'https://posthog.example.test'; authority.projectKey = 'capture-secret';
  request.mockReset(); vi.stubGlobal('fetch', request);
  request.mockResolvedValueOnce(json({ results: [{ id: 7, api_token: 'capture-secret' }, { id: 8, api_token: 'foreign' }], next: null }))
    .mockResolvedValueOnce(json({ results: [] }))
    .mockResolvedValueOnce(json({ results: [['event-id', '$ai_generation', Date.now(), trace, span, null, 'call-id', false, false, 'papercusp.model']] }));
});
afterEach(() => vi.unstubAllGlobals());

describe('configured project evidence acquisition', () => {
  it('resolves the capture token to its project, queries exact traces, and returns only safe measured fields', async () => {
    const result = await readConfiguredTraceProject([trace]);
    expect(result).toMatchObject({ status: 'available', projectId: '7', events: [{ traceId: trace, callId: 'call-id' }] });
    expect(String(request.mock.calls[2]![0])).toBe('https://posthog.example.test/api/projects/7/query/');
    expect(JSON.parse(request.mock.calls[2]![1].body).query.query).toContain(`IN ('${trace}')`);
    expect(request.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/capture-secret|query-secret/);
  });
  it('never substitutes caller selectors for a trusted consent grant', async () => {
    authority.allowed = false;
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown' });
    expect(request).not.toHaveBeenCalled();
  });
  it('refuses foreign capture/query authorities before sending credentials', async () => {
    authority.host = 'https://foreign.example.test';
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown', reason: 'capture-query-authority-mismatch' });
    expect(request).not.toHaveBeenCalled();
  });
  it('returns unknown on authentication denial without exposing a response body', async () => {
    request.mockReset().mockResolvedValue(json({ secret: 'PRIVATE_ERROR' }, 403));
    expect(await readConfiguredTraceProject([trace])).toEqual({ status: 'unknown', reason: 'project-query-unavailable-or-incomplete' });
  });
  it('refuses pagination to another origin without forwarding the query credential', async () => {
    request.mockReset().mockResolvedValue(json({ results: [], next: 'https://foreign.example.test/api/projects/' }));
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not select the first accessible project when its capture identity differs', async () => {
    request.mockReset().mockResolvedValue(json({ results: [{ id: 8, api_token: 'foreign' }], next: null }));
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown', reason: 'configured-project-unverified' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('detects a query path that returns an event for a fresh nonexistent UUID', async () => {
    request.mockReset().mockResolvedValueOnce(json({ results: [{ id: 7, api_token: 'capture-secret' }], next: null }))
      .mockResolvedValueOnce(json({ results: [['unexpected-event']] }));
    expect(await readConfiguredTraceProject([trace])).toEqual({ status: 'broken', reason: 'absent-uuid-control-returned-event' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('treats a successful empty query as availability rather than a delivery pass', async () => {
    request.mockReset().mockResolvedValueOnce(json({ results: [{ id: 7, api_token: 'capture-secret' }], next: null }))
      .mockResolvedValueOnce(json({ results: [] })).mockResolvedValueOnce(json({ results: [] }));
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'available', events: [] });
  });
  it('rejects unbounded or injectable selectors before making a query', async () => {
    expect(await readConfiguredTraceProject(["' OR 1=1"])).toMatchObject({ status: 'unknown' });
    expect(request).not.toHaveBeenCalled();
  });
  it('cannot treat foreign-trace rows as evidence for a selected trace', async () => {
    request.mockReset().mockResolvedValueOnce(json({ results: [{ id: 7, api_token: 'capture-secret' }], next: null }))
      .mockResolvedValueOnce(json({ results: [] }))
      .mockResolvedValueOnce(json({ results: [['event-id', '$ai_generation', Date.now(), 'f'.repeat(32), span, null, 'call-id', false, false, 'papercusp.model']] }));
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown' });
  });
  it.each(['span', 'parent'])('rejects a zero %s ID instead of treating it as correlation', async field => {
    request.mockReset().mockResolvedValueOnce(json({ results: [{ id: 7, api_token: 'capture-secret' }], next: null }))
      .mockResolvedValueOnce(json({ results: [] })).mockResolvedValueOnce(json({ results: [
        ['event-id', '$ai_generation', Date.now(), trace, field === 'span' ? '0'.repeat(16) : span,
          field === 'parent' ? '0'.repeat(16) : null, 'call-id', false, false, 'papercusp.model'],
      ] }));
    expect(await readConfiguredTraceProject([trace])).toMatchObject({ status: 'unknown' });
  });
});
