import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';
import telemetryTool from './telemetry';
import { setSessionConfinementResolver } from '../../capability-envelope/session-confinement-port';
import * as identity from '../coordination/identity';

const deps = vi.hoisted(() => ({
  telemetryRollup: vi.fn(),
  handlerPhaseRollup: vi.fn(),
  flagPollSuspects: vi.fn(),
  runtimeObservabilityHealth: vi.fn(),
  readRuntimeSecurityCensus: vi.fn(),
  captureAuthenticatedRuntimeSecurityCensus: vi.fn(),
  captureHostInputs: vi.fn(),
  captureKernelInputs: vi.fn(),
  readState: vi.fn(),
  readPolicy: vi.fn(),
  readClaim: vi.fn(),
  readBindings: vi.fn(),
  resolveGoal: vi.fn(),
  checkPlan: vi.fn(),
  resolveConfinement: vi.fn(),
  ensureReady: vi.fn(),
}));

vi.mock('../../dev-data', () => ({
  telemetryRollup: deps.telemetryRollup,
  handlerPhaseRollup: deps.handlerPhaseRollup,
  flagPollSuspects: deps.flagPollSuspects,
}));
vi.mock('../../observability/runtime', () => ({
  runtimeObservabilityHealth: deps.runtimeObservabilityHealth,
  readRuntimeSecurityCensus: deps.readRuntimeSecurityCensus,
}));
vi.mock('../../coverage-census/security-qualification', () => ({
  captureAuthenticatedRuntimeSecurityCensus: deps.captureAuthenticatedRuntimeSecurityCensus,
}));
vi.mock('../../serving-host-identity', () => ({
  getServingHostIdentity: () => ({ host: 'original-host', processId: 'original-process', buildSha: null }),
}));
vi.mock('../../agent-identities/idop-p001-baseline', async importOriginal => ({
  ...await importOriginal<typeof import('../../agent-identities/idop-p001-baseline')>(),
  captureIdopP001HostPermissionPorts: deps.captureHostInputs,
  captureIdopP001KernelPermissionPorts: deps.captureKernelInputs,
}));
vi.mock('../../projected-tool-deps', () => ({ readControlAnchorKernelState: deps.readState }));
vi.mock('../../capability-envelope/identity-grants-port', () => ({
  readIdentityGrantPolicy: deps.readPolicy, readCurrentOperationEffectClaim: deps.readClaim,
}));
vi.mock('../plans/plan-execution-guard', () => ({ readExecutionPlanBindings: deps.readBindings,
  readExecutionPlanGoal: deps.resolveGoal, checkExecutionPlan: deps.checkPlan }));

type ToolResponse = { content: Array<{ type: string; text: string }> };

function callTool(args: Record<string, unknown>, phases?: ReturnType<typeof createPhaseTracker>, context: Record<string, unknown> = {}) {
  return (telemetryTool as unknown as {
    handler: (args: unknown, ctx: unknown) => Promise<ToolResponse>;
  }).handler(args, { phases, ...context });
}

describe('dev:telemetry original host permission inputs', () => {
  const caller = () => ({ isSuperuser: true, uiClientId: 'su-original', workspaceId: 'original-workspace',
    runId: 'original-run', metadata: vi.fn() });
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionConfinementResolver(deps.resolveConfinement, { ensureReady: deps.ensureReady });
    deps.captureHostInputs.mockResolvedValue({ snapshot: { scope: 'captured-host-permission-read-inputs' }, sha256: 'a'.repeat(64) });
    deps.captureKernelInputs.mockResolvedValue({ snapshot: { scope: 'captured-original-kernel-permission-read-inputs' }, sha256: 'b'.repeat(64) });
    deps.runtimeObservabilityHealth.mockReturnValue({ artifact: null });
  });
  afterEach(() => { setSessionConfinementResolver(undefined); vi.restoreAllMocks(); });

  it('captures only this caller request with installed kernel readers and no convergence writer', async () => {
    const context = caller();
    const tracker = createPhaseTracker();
    const args = { view: 'kernel-permission-inputs' } as const;
    const result = JSON.parse((await callTool(args, tracker, context)).content[0].text);
    expect(result).toMatchObject({ ok: true, scope: 'original-host-self-kernel-permission-inputs',
      sha256: 'b'.repeat(64), provenance: { ownerId: 'su-original', workspaceId: 'original-workspace',
        runtime: { processId: 'original-process', buildSha: null },
        artifact: { status: 'unknown', reason: 'boot-artifact-not-measured' } } });
    const [input, ports] = deps.captureKernelInputs.mock.calls[0];
    expect(input).toEqual({ workspaceId: context.workspaceId,
      requests: [{ request: { phase: 'enforce', boundary: 'dispatch', toolName: 'dev:telemetry',
        capabilities: ['intel:read'], args, ctx: { ...context, phases: tracker }, callId: undefined,
        operation: 'dev:telemetry', appliedRevision: null, requestedRevision: null, ownership: undefined } }],
      policyInputs: [], operationClaims: [], toolNames: ['dev:telemetry'], apps: [], convergence: [],
      captureIdentityDependencies: true });
    expect(input.requests[0].request.ctx.metadata).toBe(context.metadata);
    expect(ports.inner).toEqual({ readState: deps.readState, resolveIdentity: identity.resolveAgentIdentity,
      readPolicy: deps.readPolicy, readOperationEffectClaim: deps.readClaim,
      resolveTool: (await import('@papercusp/agent-mcp')).resolveMcpName,
      runtime: { pid: process.pid, processId: 'original-process' },
      plan: { readBindings: deps.readBindings, resolveGoal: deps.resolveGoal, checkPlan: deps.checkPlan } });
    expect(ports.inner).not.toHaveProperty('converge');
    expect(Object.keys(ports.app).sort()).toEqual(['loadAccessTokenRow', 'loadRow', 'loadSpendStatus', 'lookupTool', 'now']);
    expect(deps.captureHostInputs).not.toHaveBeenCalled();
    expect(tracker.intervals().map(row => row.phase)).toEqual(['dev:telemetry:kernel-permission-inputs']);
    expect(telemetryTool.effectForCall?.(args)).toBe('read');
  });

  it.each([{ kernelBoundary: 'native' }, { dispatchBoundary: 'shell' }, { reactionCause: { id: 'original' } },
    { codeMode: true }, { telemetrySurface: 'tools:invoke' }])('retains original request boundary and revision authority %j', async fields => {
    const applied = { specificationRevision: 'original-applied', stateRevision: 'original-state' };
    const requested = { specificationRevision: 'original-requested', stateRevision: 'requested-state' };
    const ownership = { required: true, resourceOwnerId: 'su-original', resourceId: 'original-resource' };
    await callTool({ view: 'kernel-permission-inputs' }, undefined, { ...caller(), ...fields,
      dispatchCallId: 'original-call', kernelState: { activation: { applied }, requestedRevision: requested, ownership } });
    const request = deps.captureKernelInputs.mock.calls[0][0].requests[0].request;
    expect(request).toMatchObject({ appliedRevision: applied, requestedRevision: requested, ownership,
      callId: 'original-call', operation: 'dev:telemetry', boundary: 'kernelBoundary' in fields ? fields.kernelBoundary
        : 'dispatchBoundary' in fields ? fields.dispatchBoundary : 'reactionCause' in fields ? 'reaction' : 'indirect-dispatch' });
  });

  it.each([{ isSuperuser: false }, { uiClientId: '' }, { workspaceId: '' }])(
    'refuses an unauthenticated kernel capture %j before reading authority', async changed => {
      await expect(callTool({ view: 'kernel-permission-inputs' }, undefined, { ...caller(), ...changed }))
        .rejects.toThrow('requires_authenticated_superuser');
      expect(deps.captureKernelInputs).not.toHaveBeenCalled();
    });

  it('refuses foreign identity, supplied request domains and original capture failure', async () => {
    const resolved = vi.spyOn(identity, 'resolveAgentIdentity').mockReturnValue({ ownerId: 'foreign',
      workspaceId: 'original-workspace', ownerLabel: 'foreign', source: 'static-client', userId: null });
    await expect(callTool({ view: 'kernel-permission-inputs' }, undefined, caller())).rejects.toThrow('requires_matching_identity');
    resolved.mockRestore();
    await expect(callTool({ view: 'kernel-permission-inputs', requests: [{}] }, undefined, caller()))
      .rejects.toThrow('requires_self_only');
    expect(deps.captureKernelInputs).not.toHaveBeenCalled();
    deps.captureKernelInputs.mockRejectedValue(new Error('original kernel unreadable'));
    await expect(callTool({ view: 'kernel-permission-inputs' }, undefined, caller()))
      .rejects.toThrow('original kernel unreadable');
  });

  it('captures the unchanged caller through original host readers and preserves unknown provenance', async () => {
    const context = caller();
    const tracker = createPhaseTracker();
    const result = JSON.parse((await callTool({ view: 'host-permission-inputs' }, tracker, context)).content[0].text);
    expect(result).toMatchObject({ ok: true, scope: 'original-host-self-permission-inputs', sha256: 'a'.repeat(64),
      provenance: { ownerId: 'su-original', workspaceId: 'original-workspace',
        runtime: { host: 'original-host', processId: 'original-process', buildSha: null },
        artifact: { status: 'unknown', reason: 'boot-artifact-not-measured' } } });
    const [input, ports] = deps.captureHostInputs.mock.calls[0];
    expect(input).toEqual({ workspaceId: context.workspaceId, contexts: [{ ...context, phases: tracker }],
      flags: [{ key: 'papercusp-capability-envelope', distinctId: 'system' }] });
    expect(input.contexts[0].metadata).toBe(context.metadata);
    expect(ports.resolveConfinement).toBe(deps.resolveConfinement);
    await ports.ensureConfinementReady();
    expect(deps.ensureReady).toHaveBeenCalledOnce();
    expect(ports.audit.resolveIdentity).toBe(identity.resolveAgentIdentity);
    expect(ports.audit.readModes).toBe((await import('../../modes/store')).getModes);
    expect(ports.roleOverrides).toBe((await import('../../capability-envelope-overrides')).envelopeRoleOverrides);
    expect(ports.protectedAdditions).toBe((await import('../../capability-envelope-overrides')).envelopeProtectedAdditions);
    expect(ports.readFlagAttestation).toBe((await import('@papercusp/flags/server')).getFlagAttestation);
    expect(tracker.intervals().map(row => row.phase)).toEqual(['dev:telemetry:host-permission-inputs']);
    expect(deps.telemetryRollup).not.toHaveBeenCalled();
    expect(deps.readRuntimeSecurityCensus).not.toHaveBeenCalled();
    expect(deps.captureAuthenticatedRuntimeSecurityCensus).not.toHaveBeenCalled();
    expect(telemetryTool.effectForCall?.({ view: 'host-permission-inputs' })).toBe('read');
  });

  it('retains the boot-measured artifact without inventing source containment', async () => {
    const artifact = { status: 'measured', sourceSha: 'loaded-source', bundleSha256: 'boot-bundle' };
    deps.runtimeObservabilityHealth.mockReturnValue({ artifact });
    const result = JSON.parse((await callTool({ view: 'host-permission-inputs' }, undefined, caller())).content[0].text);
    expect(result.provenance.artifact).toEqual(artifact);
    expect(result).not.toHaveProperty('passed');
    expect(result).not.toHaveProperty('closureAccepted');
  });

  it.each([{ isSuperuser: false }, { uiClientId: null }, { workspaceId: '' }])(
    'refuses an unauthenticated or unscoped caller %j before reading inputs', async changed => {
      await expect(callTool({ view: 'host-permission-inputs' }, undefined, { ...caller(), ...changed }))
        .rejects.toThrow('requires_authenticated_superuser');
      expect(deps.captureHostInputs).not.toHaveBeenCalled();
    });

  it.each([{ ownerId: 'foreign', workspaceId: 'original-workspace' },
    { ownerId: 'su-original', workspaceId: 'foreign' }])('refuses a mismatched resolved identity %j', async resolved => {
    vi.spyOn(identity, 'resolveAgentIdentity').mockReturnValue({ ...resolved,
      ownerLabel: 'original caller', source: 'static-client', userId: null } satisfies identity.AgentIdentity);
    await expect(callTool({ view: 'host-permission-inputs' }, undefined, caller())).rejects.toThrow('requires_matching_identity');
    expect(deps.captureHostInputs).not.toHaveBeenCalled();
  });

  it.each([{ capture: true }, { harness: 'other' }, { workspaceIds: ['other'] }, { limit: 1 },
    { offset: 0 }, { transports: ['mcp'] }, { hours: 1 }, { phasesFor: 'other' },
    { discoverySha256: 'b'.repeat(64) }, { contexts: [{}] }, { principal: {} }])(
    'refuses supplied scope and unrelated telemetry options %j', async extra => {
      await expect(callTool({ view: 'host-permission-inputs', ...extra }, undefined, caller())).rejects.toThrow('requires_self_only');
      expect(deps.captureHostInputs).not.toHaveBeenCalled();
    });

  it('fails closed when original host ports or authority reads are unavailable', async () => {
    setSessionConfinementResolver(undefined);
    await expect(callTool({ view: 'host-permission-inputs' }, undefined, caller())).rejects.toThrow('policy is unavailable');
    expect(deps.captureHostInputs).not.toHaveBeenCalled();
    setSessionConfinementResolver(deps.resolveConfinement);
    deps.captureHostInputs.mockRejectedValue(new Error('original authority unreadable'));
    await expect(callTool({ view: 'host-permission-inputs' }, undefined, caller())).rejects.toThrow('original authority unreadable');
  });
});

describe('dev:telemetry phase attribution', () => {
  it('routes authenticated full capture to custody without reading a paged census or SQL rollup', async () => {
    const receipt = { receiptRef: 'host-receipt', snapshotRef: 'immutable-full-snapshot', closureAccepted: false };
    deps.captureAuthenticatedRuntimeSecurityCensus.mockResolvedValue(receipt);
    const result = await callTool({ view: 'security-census', capture: true, harness: 'test' });
    expect(JSON.parse(result.content[0]!.text)).toEqual(receipt);
    expect(deps.captureAuthenticatedRuntimeSecurityCensus).toHaveBeenCalledWith(expect.objectContaining({ phases: undefined }), 'test');
    expect(deps.readRuntimeSecurityCensus).not.toHaveBeenCalled(); expect(deps.telemetryRollup).not.toHaveBeenCalled();
    expect(telemetryTool.effectForCall?.({ capture: true })).toBe('write');
    expect(telemetryTool.effectForCall?.({ view: 'security-census' })).toBe('read');
  });

  it('refuses paged capture or capture on a rollup before custody runs', async () => {
    for (const args of [{ capture: true }, { view: 'rollup', capture: true },
      { view: 'security-census', capture: true, limit: 1 },
      { view: 'security-census', capture: true, offset: 0 },
      { view: 'security-census', capture: true, discoverySha256: 'a'.repeat(64) }]) {
      await expect(callTool(args)).rejects.toThrow('capture_requires_full_snapshot');
    }
    expect(deps.captureAuthenticatedRuntimeSecurityCensus).not.toHaveBeenCalled();
  });

  it('refuses capture without a concrete harness before entering custody', async () => {
    await expect(callTool({ view: 'security-census', capture: true }))
      .rejects.toThrow('capture_requires_concrete_harness');
    expect(deps.captureAuthenticatedRuntimeSecurityCensus).not.toHaveBeenCalled();
  });
  it('routes actual-host discovery without running SQL rollups', async () => {
    const captured = { status: 'unavailable', populationComplete: false, unresolved: ['host-not-registered'] };
    deps.readRuntimeSecurityCensus.mockResolvedValue(captured);
    const tracker = createPhaseTracker();
    const discoverySha256 = 'a'.repeat(64);
    const result = await callTool({ view: 'security-census', limit: 7, offset: 14, discoverySha256 }, tracker);
    expect(JSON.parse(result.content[0]!.text)).toEqual(captured);
    expect(deps.readRuntimeSecurityCensus).toHaveBeenCalledWith(7, { offset: 14, expectedDiscoverySha256: discoverySha256 });
    expect(deps.telemetryRollup).not.toHaveBeenCalled();
    expect(deps.handlerPhaseRollup).not.toHaveBeenCalled();
    expect(tracker.intervals().map(({ phase }) => phase)).toEqual(['dev:telemetry:security-census']);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    deps.telemetryRollup.mockResolvedValue({ entries: [] });
    deps.handlerPhaseRollup.mockResolvedValue({ phases: [] });
    deps.flagPollSuspects.mockReturnValue([]);
    deps.runtimeObservabilityHealth.mockReturnValue({ status: 'ok' });
  });

  it('tracks both concurrent rollup branches when phase detail is requested', async () => {
    let finishTelemetry!: (value: { entries: [] }) => void;
    let finishPhases!: (value: { phases: [] }) => void;
    deps.telemetryRollup.mockReturnValue(new Promise((resolve) => { finishTelemetry = resolve; }));
    deps.handlerPhaseRollup.mockReturnValue(new Promise((resolve) => { finishPhases = resolve; }));

    const tracker = createPhaseTracker();
    const resultPromise = callTool({ phasesFor: 'coord:orient' }, tracker);

    expect(tracker.snapshot().activePhases.sort()).toEqual([
      'dev:telemetry:handler-phase-rollup',
      'dev:telemetry:rollup',
    ]);

    finishTelemetry({ entries: [] });
    finishPhases({ phases: [] });
    await resultPromise;

    expect(tracker.intervals().map(({ phase }) => phase).sort()).toEqual([
      'dev:telemetry:handler-phase-rollup',
      'dev:telemetry:rollup',
    ]);
    expect(deps.flagPollSuspects).toHaveBeenCalledWith([], 24);
  });

  it('tracks the telemetry rollup without requesting optional phase detail', async () => {
    const tracker = createPhaseTracker();

    await callTool({}, tracker);

    expect(tracker.intervals().map(({ phase }) => phase)).toEqual(['dev:telemetry:rollup']);
    expect(deps.handlerPhaseRollup).not.toHaveBeenCalled();
  });

  it('still runs the rollup when a direct handler call has no phase tracker', async () => {
    await callTool({});

    expect(deps.telemetryRollup).toHaveBeenCalledOnce();
  });
});
