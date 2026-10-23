import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  host: { host: 'port-3170', processId: 'process-1', buildSha: 'a'.repeat(40) },
  health: { initialized: true, globalProviderRegistered: true },
  sql: vi.fn(), position: vi.fn(), readProject: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fixture.sql }) }));
vi.mock('../serving-host-identity', () => ({ getServingHostIdentity: () => fixture.host }));
vi.mock('../git-pipeline-position', () => ({ gitPipelinePosition: fixture.position }));
vi.mock('./runtime', () => ({ runtimeObservabilityHealth: () => fixture.health }));
vi.mock('./project-readback', () => ({ readConfiguredTraceProject: fixture.readProject }));
import { measureOperationalObservability } from './operational-check';
const scope = { workspaceId: 'workspace-test', harnessSlug: 'harness-test' };
const now = Date.now();
const rows = () => ['1', '2'].map((digit, i) => ({ id: digit, callId: 'call-' + digit,
  traceId: digit.repeat(32), spanId: digit.repeat(16), status: i ? 'error' : 'ok',
  startedAt: now - 1000, endedAt: now - 100 }));
const project = () => ({ status: 'available', projectId: '7', queriedAt: now, evidenceRef: 'authenticated-project-query',
  events: rows().flatMap((row, i) => [{ uuid: 'tool-' + row.id, event: '$ai_trace', timestamp: row.startedAt,
    traceId: row.traceId, spanId: row.spanId, parentSpanId: null, callId: row.callId, isError: !!i },
  { uuid: 'http-' + row.id, event: '$ai_span', timestamp: row.startedAt + 10,
    traceId: row.traceId, spanId: (i ? 'c' : 'a').repeat(16), parentSpanId: row.spanId, callId: row.callId, isError: false },
  { uuid: 'model-' + row.id, event: i ? '$exception' : '$ai_generation', timestamp: row.startedAt + 20,
    traceId: row.traceId, spanId: (i ? 'd' : 'b').repeat(16), parentSpanId: (i ? 'c' : 'a').repeat(16), callId: null, isError: !!i }]) });
beforeEach(() => {
  fixture.host = { host: 'port-3170', processId: 'process-1', buildSha: 'a'.repeat(40) };
  fixture.health = { initialized: true, globalProviderRegistered: true };
  fixture.sql.mockReset().mockResolvedValue(rows());
  fixture.position.mockReset().mockResolvedValue({ servingRuntimes: [{ runtime: 'staging-operator',
    containsChange: true, buildSha: 'a'.repeat(40) }] });
  fixture.readProject.mockReset().mockResolvedValue(project());
});

describe('operational observability measurements', () => {
  it('acquires invocation and project evidence instead of accepting a supplied receipt', async () => {
    const result = await measureOperationalObservability('project', scope);
    expect(result.verdict).toBe('pass');
    expect(JSON.parse(result.detail)).toMatchObject({ host: fixture.host, projectId: '7',
      invocations: [{ id: '1', callId: 'call-1' }, { id: '2', callId: 'call-2' }] });
    expect(fixture.sql.mock.calls[0]!.slice(1)).toEqual([scope.workspaceId, scope.harnessSlug, 'process-1', fixture.host.buildSha]);
    expect(fixture.readProject).toHaveBeenCalledWith(['1'.repeat(32), '2'.repeat(32)]);
  });
  it('cannot substitute a release/background process for the current-build route', async () => {
    fixture.host.host = 'port-3070';
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'unknown' });
    expect(fixture.sql).not.toHaveBeenCalled();
  });
  it('detects actual provider or source-containment loss before reading project events', async () => {
    fixture.health.globalProviderRegistered = false;
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail' });
    fixture.health.globalProviderRegistered = true;
    fixture.position.mockResolvedValue({ servingRuntimes: [{ runtime: 'staging-operator', containsChange: false, buildSha: fixture.host.buildSha }] });
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'fail' });
    expect(fixture.readProject).not.toHaveBeenCalled();
  });
  it('preserves unknown for inaccessible project authority and a still-open ingestion window', async () => {
    fixture.readProject.mockResolvedValueOnce({ status: 'unknown', reason: 'query-denied' });
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown', detail: 'query-denied' });
    fixture.readProject.mockResolvedValueOnce({ ...project(), events: [] });
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown' });
  });
  it('detects event absence after the ingestion bound against a functioning project query', async () => {
    fixture.sql.mockResolvedValue(rows().map(row => ({ ...row, startedAt: now - 122_000, endedAt: now - 121_000 })));
    fixture.readProject.mockResolvedValue({ ...project(), events: [] });
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail', detail: expect.stringContaining('absent after ingestion bound') });
  });
  it('rejects a cross-swapped model parent and a forged project call ID', async () => {
    const swapped = project(); swapped.events[2]!.parentSpanId = 'c'.repeat(16);
    fixture.readProject.mockResolvedValueOnce(swapped);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail', detail: expect.stringContaining('ancestry') });
    const forged = project(); forged.events[0]!.callId = 'foreign-call';
    fixture.readProject.mockResolvedValueOnce(forged);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail', detail: expect.stringContaining('call identity') });
  });
  it('requires two concurrent disjoint tool/HTTP/model chains for staging', async () => {
    fixture.sql.mockResolvedValue(rows().map(row => ({ ...row, status: 'ok' })));
    const concurrent = project(); concurrent.events[5]!.event = '$ai_generation'; concurrent.events[5]!.isError = false;
    fixture.readProject.mockResolvedValue(concurrent);
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'pass' });
    fixture.sql.mockResolvedValue(rows().map((row, i) => ({ ...row, status: 'ok', startedAt: now - 1000 + i * 950, endedAt: now - 100 + i * 99 })));
    fixture.readProject.mockResolvedValue({ ...concurrent,
      events: concurrent.events.map(event => ({ ...event, timestamp: event.timestamp + (event.traceId === '2'.repeat(32) ? 950 : 0) })) });
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'unknown' });
  });
  it('cannot turn an unreadable invocation ledger into a pass', async () => {
    fixture.sql.mockRejectedValue(new Error('PRIVATE_DATABASE_ERROR'));
    const result = await measureOperationalObservability('project', scope);
    expect(result.verdict).toBe('unknown'); expect(result.detail).not.toContain('PRIVATE_DATABASE_ERROR');
  });
});
