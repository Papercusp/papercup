import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  host: { host: 'port-3170', processId: 'process-1', buildSha: 'a'.repeat(40) },
  health: { initialized: true, globalProviderRegistered: true },
  consentSince: 0,
  sql: vi.fn(), position: vi.fn(), readProject: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fixture.sql }) }));
vi.mock('../serving-host-identity', () => ({ getServingHostIdentity: () => fixture.host }));
vi.mock('../git-pipeline-position', () => ({ gitPipelinePosition: fixture.position }));
vi.mock('./runtime', () => ({ runtimeObservabilityHealth: () => fixture.health,
  runtimeTraceDeliveryConfig: async () => ({ allowed: true, consentSince: fixture.consentSince }) }));
vi.mock('./project-readback', () => ({ readConfiguredTraceProject: fixture.readProject }));
import { measureOperationalObservability } from './operational-check';
const scope = { workspaceId: 'workspace-test', harnessSlug: 'harness-test' };
const now = Date.now();
const rows = () => ['1', '2'].map((digit, i) => ({ id: digit, callId: 'call-' + digit,
  traceId: digit.repeat(32), spanId: digit.repeat(16), status: i ? 'error' : 'ok',
  startedAt: now - 1000, endedAt: now - 100, expectedModel: !i }));
const project = () => ({ status: 'available', projectId: '7', queriedAt: now, evidenceRef: 'authenticated-project-query',
  events: rows().flatMap((row, i) => [{ uuid: 'tool-' + row.id, event: '$ai_trace', timestamp: row.startedAt,
    traceId: row.traceId, spanId: row.spanId, parentSpanId: null, callId: row.callId, isError: !!i, httpClient: false, spanName: 'papercusp.tool' },
  { uuid: 'http-' + row.id, event: '$ai_span', timestamp: row.startedAt + 10,
    traceId: row.traceId, spanId: (i ? 'c' : 'a').repeat(16), parentSpanId: row.spanId, callId: row.callId, isError: false, httpClient: true, spanName: 'papercusp.http' },
  { uuid: 'model-' + row.id, event: i ? '$exception' : '$ai_generation', timestamp: row.startedAt + 20,
    traceId: row.traceId, spanId: (i ? 'd' : 'b').repeat(16), parentSpanId: (i ? 'c' : 'a').repeat(16), callId: null, isError: !!i, httpClient: false, spanName: 'papercusp.model' }]) });
beforeEach(() => {
  fixture.host = { host: 'port-3170', processId: 'process-1', buildSha: 'a'.repeat(40) };
  fixture.health = { initialized: true, globalProviderRegistered: true };
  fixture.consentSince = 0;
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
    expect(fixture.sql.mock.calls[0]!.slice(1)).toEqual([scope.workspaceId, scope.harnessSlug, 'process-1', fixture.host.buildSha, 0]);
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
  describe.each(['project', 'staging', 'release'] as const)('%s expected-event deadline', mode => {
    function observations(kind: '$ai_generation' | '$exception', age: number, healthyNew = false) {
      const selected = rows()[kind === '$ai_generation' ? 0 : 1]!;
      const old = { ...selected, startedAt: now - age - 1000, endedAt: now - age };
      // Both independent ledger rows and the surviving anchors retain the same
      // identities. Only the expected leaf is deleted from project visibility.
      const missing = project().events.filter(event => event.traceId === old.traceId && event.event !== kind)
        .map(event => ({ ...event, timestamp: old.startedAt + 10 }));
      fixture.sql.mockResolvedValue(healthyNew ? [old, ...rows().map(row => ({ ...row,
        id: 'new-' + row.id, callId: 'new-' + row.callId, traceId: (row.id === '1' ? '3' : '4').repeat(32) }))] : [old]);
      fixture.readProject.mockResolvedValue({ ...project(), events: healthyNew ? [...missing,
        ...project().events.map(event => ({ ...event, traceId: (event.traceId[0] === '1' ? '3' : '4').repeat(32),
          callId: event.callId ? 'new-' + event.callId : null }))] : missing });
      if (mode === 'release') {
        fixture.host.host = 'port-3070';
        const paths = ['packages/operator-core/lib/observability/runtime.ts', 'packages/operator-core/lib/observability/tracing.ts',
          'packages/operator-core/lib/observability/posthog-exporter.ts', 'packages/operator-core/lib/projected-tool-deps.ts',
          'packages/operator-core/lib/inference-gateway/gateway.ts', 'apps/operator/bin/host-bootstrap.ts'];
        Object.assign(fixture.health, { artifact: { status: 'measured', sourceSha: fixture.host.buildSha,
          bundleSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
          sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) } });
        fixture.position.mockResolvedValue({ servingRuntimes: [{ runtime: 'release-operator', containsChange: true, buildSha: fixture.host.buildSha }] });
        fixture.sql.mockResolvedValueOnce([{ count: 1, manifests: 1, matches: true, ref: 'writer-1' }])
          .mockResolvedValueOnce([{ matched: true }])
          .mockResolvedValueOnce([{ id: 'green-1', detail: { candidate: fixture.host.buildSha, green: true, runId: 'run-1' } }]);
      }
    }
    it.each(['$ai_generation', '$exception'] as const)('fails partial %s delivery at and after its deadline despite healthy replacements', async kind => {
      for (const age of [120_000, 120_001, 300_000]) {
        observations(kind, age, true);
        expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'fail',
          detail: expect.stringContaining('Expected ' + kind + ' absent after ingestion bound; invocation=') });
      }
    });
    it.each(['$ai_generation', '$exception'] as const)('keeps %s predeadline and denied queries unknown', async kind => {
      observations(kind, 119_999);
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'unknown' });
      observations(kind, 120_001);
      fixture.readProject.mockResolvedValueOnce({ status: 'unknown', reason: 'query-denied' });
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'unknown', detail: 'query-denied' });
    });
    it.each(['$ai_generation', '$exception'] as const)('accepts a restored expired %s with fresh healthy controls', async kind => {
      observations(kind, 120_001, true);
      const old = rows()[kind === '$ai_generation' ? 0 : 1]!;
      const fresh = rows().map(row => ({ ...row, id: 'new-' + row.id, callId: 'new-' + row.callId,
        traceId: (row.id === '1' ? '3' : '4').repeat(32),
        ...(mode === 'staging' ? { status: 'ok', expectedModel: true } : {}) }));
      // Preserve the release writer/green one-shot query responses.
      fixture.sql.mockResolvedValue([{ ...old, startedAt: now - 121_001, endedAt: now - 120_001 }, ...fresh]);
      fixture.readProject.mockResolvedValue({ ...project(), events: [
        ...project().events.filter(event => event.traceId === old.traceId)
          .map(event => ({ ...event, timestamp: now - 121_000 })),
        ...project().events.map(event => ({ ...event, traceId: (event.traceId[0] === '1' ? '3' : '4').repeat(32),
          callId: event.callId ? 'new-' + event.callId : null,
          ...(mode === 'staging' && event.event === '$exception' ? { event: '$ai_generation', isError: false } : {}) })),
      ] });
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'pass' });
      expect(fixture.readProject).toHaveBeenLastCalledWith([old.traceId, '3'.repeat(32), '4'.repeat(32)]);
    });
    function modelThenToolError(age: number, missing: '$ai_generation' | '$exception' | null) {
      observations('$ai_generation', age, true);
      const old = { ...rows()[0]!, status: 'error', expectedModel: true,
        startedAt: now - age - 1000, endedAt: now - age };
      const fresh = rows().map(row => ({ ...row, id: 'new-' + row.id, callId: 'new-' + row.callId,
        traceId: (row.id === '1' ? '3' : '4').repeat(32),
        ...(mode === 'staging' ? { status: 'ok', expectedModel: true } : {}) }));
      fixture.sql.mockResolvedValue([old, ...fresh]);
      const oldEvents = project().events.filter(event => event.traceId === old.traceId)
        .map(event => ({ ...event, timestamp: old.startedAt + 10 }));
      oldEvents.push({ ...oldEvents[0]!, uuid: 'tool-error-1', event: '$exception',
        timestamp: old.endedAt, isError: true });
      fixture.readProject.mockResolvedValue({ ...project(), events: [
        ...oldEvents.filter(event => event.event !== missing),
        ...project().events.map(event => ({ ...event,
          traceId: (event.traceId[0] === '1' ? '3' : '4').repeat(32),
          callId: event.callId ? 'new-' + event.callId : null,
          ...(mode === 'staging' && event.event === '$exception' ? { event: '$ai_generation', isError: false } : {}) })),
      ] });
    }
    it.each(['$ai_generation', '$exception'] as const)('requires independent %s delivery when a model succeeds before its tool fails', async missing => {
      for (const age of [120_000, 120_001, 300_000]) {
        modelThenToolError(age, missing);
        expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'fail',
          detail: expect.stringContaining('Expected ' + missing + ' absent after ingestion bound; invocation=1') });
      }
    });
    it.each(['$ai_generation', '$exception'] as const)('keeps a mixed-outcome %s obligation unknown before deadline or without query authority', async missing => {
      modelThenToolError(119_999, missing);
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'unknown' });
      modelThenToolError(120_001, missing);
      fixture.readProject.mockResolvedValueOnce({ status: 'unknown', reason: 'query-denied' });
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'unknown', detail: 'query-denied' });
    });
    it('retains both mixed-outcome obligations and accepts their complete delivery', async () => {
      modelThenToolError(300_000, null);
      const result = await measureOperationalObservability(mode, scope);
      expect(result.verdict).toBe('pass');
      const expected = JSON.parse(result.detail).expected.filter((row: { id: string }) => row.id === '1');
      expect(expected).toEqual([
        expect.objectContaining({ event: '$ai_generation', deadline: now - 180_000 }),
        expect.objectContaining({ event: '$exception', deadline: now - 180_000 }),
      ]);
    });
  });
  it('does not infer model use from an arbitrary successful tool and retains sanitized evidence on a pass', async () => {
    fixture.sql.mockResolvedValueOnce(rows().map(row => ({ ...row, status: 'ok', expectedModel: false })));
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown' });
    const result = await measureOperationalObservability('project', scope);
    expect(result.verdict).toBe('pass');
    expect(JSON.parse(result.detail)).toMatchObject({ observedEvents: project().events,
      expected: [{ id: '1', event: '$ai_generation', deadline: rows()[0]!.endedAt + 120_000 },
        { id: '2', event: '$exception', deadline: rows()[1]!.endedAt + 120_000 }] });
    const sqlText = fixture.sql.mock.calls.at(-1)![0].join('');
    expect(sqlText).not.toContain("interval '240 seconds'");
    expect(sqlText).toContain('ORDER BY id ASC');
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
    fixture.sql.mockResolvedValue(rows().map(row => ({ ...row, status: 'ok', expectedModel: true })));
    const concurrent = project(); concurrent.events[5]!.event = '$ai_generation'; concurrent.events[5]!.isError = false;
    fixture.readProject.mockResolvedValue(concurrent);
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'pass' });
    fixture.readProject.mockResolvedValueOnce({ ...concurrent,
      events: concurrent.events.map(event => ({ ...event, httpClient: false })) });
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'fail' });
    fixture.sql.mockResolvedValue(rows().map((row, i) => ({ ...row, status: 'ok', expectedModel: true, startedAt: now - 1000 + i * 950, endedAt: now - 100 + i * 99 })));
    fixture.readProject.mockResolvedValue({ ...concurrent,
      events: concurrent.events.map(event => ({ ...event, timestamp: event.timestamp + (event.traceId === '2'.repeat(32) ? 950 : 0) })) });
    expect(await measureOperationalObservability('staging', scope)).toMatchObject({ verdict: 'unknown' });
  });
  it('cannot turn an unreadable invocation ledger into a pass', async () => {
    fixture.sql.mockRejectedValue(new Error('PRIVATE_DATABASE_ERROR'));
    const result = await measureOperationalObservability('project', scope);
    expect(result.verdict).toBe('unknown'); expect(result.detail).not.toContain('PRIVATE_DATABASE_ERROR');
  });
  it('rejects arbitrary SHA prefixes and zero persisted span identities', async () => {
    fixture.host.buildSha = 'a';
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown' });
    fixture.host.buildSha = 'a'.repeat(40);
    fixture.sql.mockResolvedValue(rows().map(row => ({ ...row, spanId: '0'.repeat(16) })));
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown' });
  });
  it('cannot replace the canonical tool anchor with a generic same-span observation', async () => {
    const generic = project(); generic.events[0]!.spanName = 'papercusp.span';
    fixture.readProject.mockResolvedValue(generic);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'unknown' });
    const ambiguous = project(); ambiguous.events.push({ ...ambiguous.events[0]!, uuid: 'other-anchor' });
    fixture.readProject.mockResolvedValue(ambiguous);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail' });
  });
  it('rejects foreign leaf call IDs and unanchored null leaves while preserving parent-bound models', async () => {
    const foreign = project(); foreign.events[2]!.callId = 'foreign-call';
    fixture.readProject.mockResolvedValueOnce(foreign);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail' });
    const direct = project(); direct.events[2]!.parentSpanId = '1'.repeat(16);
    fixture.readProject.mockResolvedValueOnce(direct);
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'fail' });
    expect(await measureOperationalObservability('project', scope)).toMatchObject({ verdict: 'pass' });
  });
  describe('release artifact acquisition', () => {
    const paths = ['packages/operator-core/lib/observability/runtime.ts', 'packages/operator-core/lib/observability/tracing.ts',
      'packages/operator-core/lib/observability/posthog-exporter.ts', 'packages/operator-core/lib/projected-tool-deps.ts',
      'packages/operator-core/lib/inference-gateway/gateway.ts', 'apps/operator/bin/host-bootstrap.ts'];
    function release() {
      fixture.host.host = 'port-3070';
      Object.assign(fixture.health, { artifact: { status: 'measured', sourceSha: fixture.host.buildSha,
        bundleSha256: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
        sourceBlobs: Object.fromEntries(paths.map(path => [path, 'd'.repeat(40)])) } });
      fixture.position.mockResolvedValue({ servingRuntimes: [{ runtime: 'release-operator',
        containsChange: true, buildSha: fixture.host.buildSha }] });
      fixture.sql.mockResolvedValueOnce([{ count: 1, manifests: 1, matches: true, ref: 'writer-1' }])
        .mockResolvedValueOnce([{ matched: true }])
        .mockResolvedValueOnce([{ id: 'green-1', detail: { candidate: fixture.host.buildSha, green: true, runId: 'run-1' } }]);
    }
    it('joins real acquisition seams before grading fresh release project journeys', async () => {
      release();
      const result = await measureOperationalObservability('release', scope);
      expect(result.verdict).toBe('pass');
      expect(JSON.parse(result.detail).release).toMatchObject({ writer: 'audit_log:writer-1',
        green: 'pipeline_events:green-1', bundleSha256: 'b'.repeat(64) });
      const shipment = JSON.parse(result.detail).shipment;
      expect(shipment.validation).toEqual({ verdict: 'healthy', failures: [] });
      expect(shipment.receipt.journeys[0]).toMatchObject({ callId: 'call-1',
        eventUuid: 'model-1', invocation: { evidenceRef: 'tool_invocations:1' } });
      expect(shipment.observedEvents.find((event: { uuid: string }) => event.uuid === 'model-1').callId).toBeNull();
      expect(fixture.sql).toHaveBeenCalledTimes(4);
    });
    it('fails the operational check when the retained receipt detector rejects measured event identity', async () => {
      release();
      const unreadable = project(); unreadable.events[2]!.uuid = '';
      fixture.readProject.mockResolvedValueOnce(unreadable);
      const result = await measureOperationalObservability('release', scope);
      expect(result.verdict).toBe('fail');
      expect(JSON.parse(result.detail).validation.failures).toContain('duplicate-or-empty-event-uuid');
      fixture.sql.mockReset().mockResolvedValue(rows()); release();
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
    });
    it.each(['writer', 'manifest', 'green', 'absent-green'] as const)('rejects substituted %s evidence with a healthy control', async fault => {
      release(); fixture.sql.mockReset().mockResolvedValue(rows());
      fixture.sql.mockResolvedValueOnce([{ count: 1, manifests: 1, matches: fault !== 'writer', ref: 'writer-1' }])
        .mockResolvedValueOnce([{ matched: fault !== 'manifest' }])
        .mockResolvedValueOnce(fault === 'absent-green' ? [] : [{ id: 'green-1',
          detail: { candidate: fixture.host.buildSha, green: fault !== 'green', runId: 'run-1' } }]);
      const result = await measureOperationalObservability('release', scope);
      expect(result.verdict).toBe(fault === 'absent-green' ? 'unknown' : 'fail');
      fixture.sql.mockReset().mockResolvedValue(rows()); release();
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'pass' });
    });
    it('cannot borrow staging identity or omit the boot artifact', async () => {
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'unknown' });
      fixture.host.host = 'port-3070';
      fixture.position.mockResolvedValue({ servingRuntimes: [{ runtime: 'release-operator',
        containsChange: true, buildSha: fixture.host.buildSha }] });
      expect(await measureOperationalObservability('release', scope)).toMatchObject({ verdict: 'unknown' });
    });
  });
  describe.each(['project', 'staging'] as const)('%s canonical HTTP parent', mode => {
    const observations = () => {
      const observed = project();
      if (mode === 'staging') {
        fixture.sql.mockResolvedValue(rows().map(row => ({ ...row, status: 'ok', expectedModel: true })));
        observed.events[5]!.event = '$ai_generation';
        observed.events[5]!.isError = false;
      }
      return observed;
    };
    it.each([1, 4])('rejects a non-span HTTP parent at event %s', async index => {
      const wrongEvent = observations();
      wrongEvent.events[index]!.event = '$ai_trace';
      fixture.readProject.mockResolvedValueOnce(wrongEvent);
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'fail' });
      fixture.readProject.mockResolvedValue(observations());
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'pass' });
    });
    it.each([1, 4])('rejects duplicate same-signature HTTP parents at event %s', async index => {
      const duplicated = observations();
      duplicated.events.push({ ...duplicated.events[index]!, uuid: 'duplicate-http-parent' });
      fixture.readProject.mockResolvedValueOnce(duplicated);
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'fail' });
      fixture.readProject.mockResolvedValue(observations());
      expect(await measureOperationalObservability(mode, scope)).toMatchObject({ verdict: 'pass' });
    });
  });
});
