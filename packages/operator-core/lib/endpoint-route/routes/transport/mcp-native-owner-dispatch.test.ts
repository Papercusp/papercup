import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProjectedTool, unregisterProjectedToolsForPlugin, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchNativeMcpTargetOnOwner, type BuiltSpawnContext } from './_mcp-host';
import type { SuNativeToolAddress } from '../../../su-session-owner-routing';
const telemetry = vi.hoisted(() => ({ recordInvocation: vi.fn() }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  withWorkspace: vi.fn(async () => { throw new Error('fixture principal synthesis failed'); }),
  retryOnRetryableDbDeadline: async (run: () => Promise<unknown>) => run(),
}));

// Exercise the real generic dispatcher and rebuilt context without an external
// DB. Monetary admission/retention has its own suite; this fixture claims none.
vi.mock('../../../projected-tool-deps', () => ({
  PROJECTED_DEPS: telemetry, backfillResultDoorOutputRef: vi.fn(), wrapOperatorKernelSpawn: vi.fn(),
}));

const fingerprint = createHash('sha256').update('native-test-thread').digest('hex');
const address: SuNativeToolAddress = { workspaceId: 'native-fixture', advSessionId: 77,
  ownerId: 'su-fixture', nativeSessionIdFingerprint: fingerprint };
const spawn: BuiltSpawnContext = {
  workspaceId: address.workspaceId, harnessSlug: '*', role: 'operator', featureId: null, chunkId: null,
  runId: 'native-fixture', spawnId: 'per-request-never-owner', parentSpawnId: null,
  uiClientId: address.ownerId, detectorSessionKey: null, advSessionId: 77, isSuperuser: true,
  requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
    candidateAdvSessionId: 77, valueFingerprint: fingerprint, callIdFingerprint: 'a'.repeat(64) } },
};
const request = () => ({ toolName: 'native-fixture:run', args: { value: 7 }, spawn: structuredClone(spawn),
  fullSource: true, structuredSource: true, sourceProjection: { pick: ['value'] }, indirect: false,
  requestedFormat: 'compact', requestedStructured: true, requestedDelta: 'cursor', idempotencyKey: 'native-key' });
function target(fn: (args: unknown, ctx: UnifiedToolContext) => Promise<unknown>, extra: Partial<ProjectedTool> = {}) {
  registerProjectedTool({ name: 'run', pluginName: 'native-fixture', roles: ['operator'],
    expose: { mcp: { name: 'native-fixture:run' } }, requirePrincipal: false,
    ...extra, fn } as ProjectedTool);
}
afterEach(() => { unregisterProjectedToolsForPlugin('native-fixture'); telemetry.recordInvocation.mockClear(); });

describe('D-063 owner rebuild of native MCP targets', () => {
  it('uses the owning loaded handler and preserves materialization and native call lineage', async () => {
    const fn = vi.fn(async (_args, ctx: UnifiedToolContext) => {
      expect(ctx.requestOrigin).toEqual(spawn.requestOrigin);
      expect(ctx.principal?.slug).toBe('system:operator');
      expect(ctx.uiClientId).toBe(address.ownerId);
      expect(ctx.spawnId).toBe('per-request-never-owner');
      expect(() => ctx.tx).toThrow('workspace_tx_not_declared');
      expect(ctx.contextTier).toBe('full'); expect(ctx.payloadTierOverride).toBe('full');
      expect(ctx.transportCapExempt).toBe(true); expect(ctx.requestedFormat).toBe('json');
      expect(ctx.requestedStructured).toBe(true); expect(ctx.requestedDelta).toBe('cursor');
      expect(ctx.idempotencyKey).toBe('native-key'); expect(ctx.sourceProjection).toEqual({ pick: ['value'] });
      expect(typeof ctx.dispatchTool).toBe('function');
      return { content: [{ type: 'text', text: 'owner-result' }] };
    });
    target(fn);
    expect(await dispatchNativeMcpTargetOnOwner(JSON.parse(JSON.stringify(request())), address))
      .toMatchObject({ content: [{ type: 'text', text: 'owner-result' }] });
    expect(fn).toHaveBeenCalledExactlyOnceWith({ value: 7 }, expect.any(Object));
  });

  it.each(['workspace', 'adv', 'owner', 'thread', 'carrier', 'unbound'] as const)(
    'refuses a mismatched %s before handler execution', async kind => {
      const fn = vi.fn(); target(fn); const r = request();
      if (kind === 'workspace') r.spawn.workspaceId = 'other';
      if (kind === 'adv') r.spawn.advSessionId = 78;
      if (kind === 'owner') r.spawn.uiClientId = 'su-other';
      if (kind === 'thread') r.spawn.requestOrigin!.nativeSession!.valueFingerprint = 'b'.repeat(64);
      if (kind === 'carrier') r.spawn.requestOrigin!.nativeSession!.carrier = 'query:native_session';
      if (kind === 'unbound') r.spawn.requestOrigin!.nativeSession!.binding = 'unbound';
      await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow(/native_tool_owner/);
      expect(fn).not.toHaveBeenCalled();
    });

  it('rejects nonserializable principal grants rather than losing them during IPC', async () => {
    const fn = vi.fn(); target(fn); const r = request();
    r.spawn.authenticatedPrincipal = { slug: 'pi', capabilities: new Set(['grant']) } as never;
    await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow('invalid_request');
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses malformed call fingerprints before the handler', async () => {
    const fn = vi.fn(); target(fn); const r = request();
    r.spawn.requestOrigin!.nativeSession!.callIdFingerprint = 'unbound-call';
    await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow('invalid_lineage');
    expect(fn).not.toHaveBeenCalled(); expect(telemetry.recordInvocation).not.toHaveBeenCalled();
  });

  it('records owner principal synthesis failure once before dispatch', async () => {
    const fn = vi.fn(); target(fn, { requirePrincipal: true });
    await expect(dispatchNativeMcpTargetOnOwner(request(), address)).rejects.toThrow('fixture principal synthesis failed');
    expect(fn).not.toHaveBeenCalled();
    expect(telemetry.recordInvocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      toolName: 'native-fixture:run', status: 'error', args: { value: 7 },
      ctx: expect.objectContaining({ uiClientId: address.ownerId, requestOrigin: spawn.requestOrigin }),
    }));
  });

  it('lets generic owner dispatch record a thrown handler once', async () => {
    const fn = vi.fn(async () => { throw new Error('fixture handler failed'); }); target(fn);
    expect(await dispatchNativeMcpTargetOnOwner(request(), address)).toMatchObject({ isError: true });
    expect(fn).toHaveBeenCalledOnce(); expect(telemetry.recordInvocation).toHaveBeenCalledOnce();
  });

  it('marks indirect targets and honors explicit tier with structured JSON materialization', async () => {
    target(vi.fn(async (_args, ctx) => {
      expect(ctx.indirectDispatch).toBe(true); expect(ctx.contextTier).toBe('trimmed');
      expect(ctx.transportCapExempt).not.toBe(true); expect(ctx.requestedFormat).toBe('json');
      return { content: [{ type: 'text', text: 'indirect' }] };
    }));
    const r = request(); r.fullSource = false; r.indirect = true; r.spawn.contextTier = 'trimmed';
    expect(await dispatchNativeMcpTargetOnOwner(r, address)).toMatchObject({ content: [{ text: 'indirect' }] });
  });
});
