import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  capture: vi.fn(async (_input: unknown) => null),
  failInsert: false,
  commits: 0,
  inserts: [] as unknown[][],
}));
vi.mock('./harness/improvements/invocation-friction', () => ({ captureInvocationFriction: io.capture }));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', () => ({ maybeBeatPresenceOnDispatch: vi.fn() }));
vi.mock('./agent-tools/coordination/identity', async (original) => ({
  ...(await original<object>()), resolveAgentIdentity: (ctx: { ownerId?: string }) => ({ ownerId: ctx.ownerId }),
}));
vi.mock('./serving-host-identity', () => ({
  getServingHostIdentity: () => ({ host: 'fixture-host', processId: 123, buildSha: 'loaded-build' }),
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()),
  getOrgPg: () => ({
    sql: { begin: async (callback: (tx: unknown) => Promise<void>) => {
      await callback({ unsafe: async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO harness_shared.tool_invocations')) {
          if (io.failInsert) throw new Error('insert failed');
          io.inserts.push(params);
          return [{ id: String(io.inserts.length) }];
        }
      } });
      io.commits++;
    } },
    db: { insert: () => ({ values: async () => {} }) },
  }),
}));

import { PROJECTED_DEPS, __resetTelemetryHealthForTests, flushPendingTelemetry, getTelemetryHealth } from './projected-tool-deps';
import { drainDetached } from './detached-imports';

function record(overrides: Record<string, unknown> = {}) {
  return PROJECTED_DEPS.recordInvocation!({
    toolName: 'coord:send', pluginName: 'agent-mcp', windowKey: 'fixture', durationMs: 1,
    ctx: { workspaceId: 'ws-test', harnessSlug: 'papercusp', ownerId: 'su-a', role: 'su', spawnId: 'su-a' },
    status: 'invalid-input', errorCode: 'invalid_input', errorMessage: 'body: must be an array',
    args: { body: 'wrong shape' }, ...overrides,
  } as never);
}

describe('committed invocation friction bridge (R-7)', () => {
  beforeEach(() => {
    __resetTelemetryHealthForTests();
    io.capture.mockReset().mockResolvedValue(null);
    io.commits = 0;
    io.inserts = [];
    io.failInsert = false;
  });
  afterEach(async () => { await flushPendingTelemetry(); await drainDetached(); __resetTelemetryHealthForTests(); });

  it('captures each retry only after commit, without incident fields or a dispatch-path write', async () => {
    io.capture.mockImplementation(async () => {
      expect(io.commits).toBe(1);
      return null;
    });
    await record();
    await record();
    expect(io.capture).not.toHaveBeenCalled();
    expect(io.inserts).toHaveLength(0);
    await flushPendingTelemetry();
    await drainDetached();
    expect(io.inserts).toHaveLength(2);
    expect(io.capture).toHaveBeenCalledTimes(2);
    const first = io.capture.mock.calls[0][0];
    expect(first).toEqual({ workspaceId: 'ws-test', id: '1' });
    expect(JSON.parse(io.inserts[0][19] as string)).toMatchObject({ frictionCapture: 'pending' });
    expect(io.inserts[0][33]).toBe('loaded-build');
    expect(first).not.toHaveProperty('args');
    expect(first).not.toHaveProperty('failure.reproduced');
  });

  it('retains framework-owned schema provenance and snapshots mutable input before defer', async () => {
    const invalidInput = { source: 'projected-tool-registry', registryRevision: 'schema-v1', toolName: 'coord:send' };
    await record({ metadataJson: { invalidInput } });
    invalidInput.registryRevision = 'changed-after-dispatch';
    await flushPendingTelemetry();
    await drainDetached();
    expect(JSON.parse(io.inserts[0][19] as string)).toMatchObject({ invalidInput: { registryRevision: 'schema-v1' } });
  });

  it.each(['ok', 'replayed', 'role-not-allowed', 'quota-exceeded', 'refused'])('does not capture %s as a new suspected failure', async (status) => {
    await record({ status });
    await flushPendingTelemetry();
    expect(io.capture).not.toHaveBeenCalled();
  });

  it('excludes the capture loop and unknown reporters', async () => {
    await record({ toolName: 'improvements:capture' });
    await record({ toolName: 'system:improvement-watchdog' });
    await record({ ctx: { workspaceId: 'ws-test', role: 'su', spawnId: 'unknown' } });
    await flushPendingTelemetry();
    expect(io.capture).not.toHaveBeenCalled();
  });

  it('owns the pending marker even when handler metadata tries to forge delivery or eligibility', async () => {
    await record({ metadataJson: { frictionCapture: 'delivered' } });
    await record({ status: 'ok', metadataJson: { frictionCapture: 'pending' } });
    await flushPendingTelemetry();
    await drainDetached();
    expect(JSON.parse(io.inserts[0][19] as string)).toHaveProperty('frictionCapture', 'pending');
    expect(io.inserts[1][19]).toBeNull();
    expect(io.capture).toHaveBeenCalledTimes(1);
  });

  it('does not capture evidence from a rolled-back telemetry batch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    io.failInsert = true;
    await record();
    await flushPendingTelemetry();
    expect(io.capture).not.toHaveBeenCalled();
    expect(io.commits).toBe(0);
    expect(getTelemetryHealth().insertErrorCount).toBe(1);
  });

  it('keeps committed telemetry and subsequent captures when one capture fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    io.capture.mockRejectedValueOnce(new Error('capture failed'));
    await record();
    await record();
    await flushPendingTelemetry();
    await drainDetached();
    expect(io.inserts).toHaveLength(2);
    expect(io.capture).toHaveBeenCalledTimes(2);
    expect(getTelemetryHealth().insertErrorCount).toBe(0);
    expect(getTelemetryHealth().frictionErrorCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invocation retained'));
  });

  it('does not block later telemetry visibility or queue unbounded captures when a capture stalls', async () => {
    let release!: () => void;
    io.capture.mockImplementationOnce(() => new Promise<null>(resolve => { release = () => resolve(null); }));
    await record();
    await flushPendingTelemetry();
    // Advance the dynamic import until the capture owns its held promise.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      await record();
      await flushPendingTelemetry();
      expect(io.inserts).toHaveLength(2);
      expect(io.capture).toHaveBeenCalledTimes(1);
      expect(getTelemetryHealth().frictionSkippedCount).toBe(1);
      expect(JSON.parse(io.inserts[1][19] as string)).toHaveProperty('frictionCapture', 'pending');
    } finally { release(); }
    await drainDetached();
    await record();
    await flushPendingTelemetry();
    await drainDetached();
    expect(io.capture).toHaveBeenCalledTimes(2);
  });
});
