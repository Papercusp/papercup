import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  _resetWorkspaceHostProvidersForTests,
  configureWorkspaceHostProviders,
  registeredWorkspaceHostProviderTargets,
  registerWorkspaceHostProvider,
  registerWorkspaceHostProviderFactory,
  resolveWorkspaceHostProvider,
} from './workspace-host-registry';
import { WORKSPACE_HOST_LIFECYCLE_ACTIONS } from './workspace-host-types';
import type {
  AgentCredentialRef,
  CloudCredentialRef,
  GitCredentialRef,
  WorkspaceHostApplyResult,
  WorkspaceHostCredentialRefs,
  WorkspaceHostProvider,
} from './workspace-host-types';

function fakeProvider(target: string): WorkspaceHostProvider {
  return {
    target,
    capabilities: {
      discovery: { scopes: true, regions: true, sizes: true, images: true, priceEstimates: true },
      lifecycle: { start: true, stop: true, restart: true, snapshot: true, restore: true, upgrade: true, repair: true, confirmedDestroy: true, hostBootstrap: false },
      transportKinds: ['ssh'],
    },
    async validateConnection() { return { ok: true, checkedAt: '2026-08-22T00:00:00Z', warnings: [], errors: [] }; },
    async listScopes() { return [{ kind: 'project', id: 'p1', label: 'Project 1' }]; },
    async listRegions() { return [{ id: 'r1', label: 'Region 1', available: true }]; },
    async listSizes() { return [{ id: 's1', label: 'Small', cpuCount: 2, memoryMiB: 4096, available: true }]; },
    async listImages() { return [{ id: 'ubuntu-24-04', label: 'Ubuntu 24.04', signed: true }]; },
    async estimatePrice() { return { currency: 'USD', hourlyAmount: 0.1, observedAt: '2026-08-22T00:00:00Z', confidence: 'estimated' }; },
    async plan(request) {
      return { planId: `plan:${request.operationId}`, operationId: request.operationId, target,
        hostId: request.action === 'provision' ? request.desired.hostId : request.host.hostId,
        generatedAt: '2026-08-22T00:00:00Z', steps: [], warnings: [] };
    },
    async apply(request) { return { state: 'unchanged', operationId: request.operationId, stepId: request.step.id, observedAt: '2026-08-22T00:00:00Z' }; },
    async observe(host) { return { host, state: 'running', resources: host.resources, observedAt: '2026-08-22T00:00:00Z', drift: [] }; },
    async reconcile(request) { return { state: 'unchanged', operationId: request.operationId, stepId: request.step.id, observedAt: '2026-08-22T00:00:00Z' }; },
    async getTransportProfile() {
      return { kind: 'ssh', supportedClientPlatforms: ['linux'], features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
        prerequisites: [], constraints: [], reconnect: 'recreate', audited: true,
        compatibility: {
          requirements: [],
          traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
          limits: { unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'], notes: [] },
          proxy: { mode: 'supported', notes: [] },
          cost: { model: 'included', meters: [], notes: [] },
          audit: {
            controlPlaneEvents: true,
            sessionMetadata: true,
            sessionContent: false,
            fileTransferEvents: false,
            notes: [],
          },
          hostKey: {
            initialEnrollment: 'verify-before-connect',
            replacement: 'block-and-reverify',
            notes: [],
          },
          fallbacks: [],
        } };
    },
    async attestHealth(host) { return { hostId: host.hostId, observedAt: '2026-08-22T00:00:00Z', status: 'healthy', checks: [] }; },
  };
}

describe('workspace-host provider contract', () => {
  beforeEach(() => _resetWorkspaceHostProvidersForTests());

  it('covers the full durable lifecycle without the four frame verbs', () => {
    expect(WORKSPACE_HOST_LIFECYCLE_ACTIONS).toEqual([
      'provision', 'start', 'stop', 'restart', 'snapshot', 'restore', 'upgrade', 'repair', 'destroy', 'initialize',
    ]);
  });

  it('keeps cloud, Git, and agent credential references type-distinct', () => {
    expectTypeOf<WorkspaceHostCredentialRefs['cloudCredentialRef']>().toEqualTypeOf<CloudCredentialRef>();
    expectTypeOf<WorkspaceHostCredentialRefs['gitCredentialRef']>().toEqualTypeOf<GitCredentialRef | undefined>();
    expectTypeOf<WorkspaceHostCredentialRefs['agentCredentialRef']>().toEqualTypeOf<AgentCredentialRef | undefined>();
  });

  it('requires fresh provider-read proof in a destroyed result', () => {
    type Destroyed = Extract<WorkspaceHostApplyResult, { state: 'destroyed' }>;
    expectTypeOf<Destroyed['confirmation']['source']>().toEqualTypeOf<'provider-read'>();
    expectTypeOf<Destroyed['confirmation']['confirmedAbsentAt']>().toEqualTypeOf<string>();
  });

  it('has no implicit local provider and reports targets on a miss', () => {
    expect(registeredWorkspaceHostProviderTargets()).toEqual([]);
    expect(() => resolveWorkspaceHostProvider('gcp')).toThrow("No workspace-host provider registered for target 'gcp'. Registered: []");
  });

  it('registers, resolves, batch-configures, and replaces open targets', () => {
    const gcp1 = fakeProvider('gcp');
    const gcp2 = fakeProvider('gcp');
    const aws = fakeProvider('aws');
    registerWorkspaceHostProvider(gcp1);
    expect(resolveWorkspaceHostProvider({ target: 'gcp' })).toBe(gcp1);
    configureWorkspaceHostProviders({ providers: [aws, gcp2] });
    expect(registeredWorkspaceHostProviderTargets().sort()).toEqual(['aws', 'gcp']);
    expect(resolveWorkspaceHostProvider('gcp')).toBe(gcp2);
  });

  it('resolves connection-aware factories without exposing backend construction to the controller', () => {
    const provider = fakeProvider('gcp');
    const factory = vi.fn(() => provider);
    registerWorkspaceHostProviderFactory('gcp', factory);
    const connection = {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
      scope: { kind: 'project', id: 'project-1' },
    } as const;

    expect(resolveWorkspaceHostProvider(connection)).toBe(provider);
    expect(factory).toHaveBeenCalledWith(connection);
    expect(() => resolveWorkspaceHostProvider('gcp')).toThrow(/requires a connection-aware registry lookup/);
  });
});
