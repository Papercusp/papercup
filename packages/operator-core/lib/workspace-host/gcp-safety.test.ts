import { describe, expect, it } from 'vitest';
import type { WorkspaceHostResourceRef } from '@papercusp/deployment-driver';
import {
  GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
  GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS,
  GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS,
  censusGcpWorkspaceHostResources,
  createGcpWorkspaceHostAmbiguousOperationRecoveryRecord,
  decideGcpWorkspaceHostRuntimeSafety,
  evaluateGcpWorkspaceHostSafetyPreflight,
  gcpWorkspaceHostLabelValue,
} from './gcp-safety';

const NOW = '2026-08-23T00:00:00.000Z';
const HOUR = 60 * 60 * 1_000;

function resource(kind: string, providerId: string): WorkspaceHostResourceRef {
  return { target: 'gcp', kind, providerId, parentProviderId: 'project-1', zone: 'us-central1-a' };
}

function labels(hostId = 'host-1', workspaceId = 'workspace-1') {
  return {
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: gcpWorkspaceHostLabelValue(hostId),
    [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: gcpWorkspaceHostLabelValue(workspaceId),
  };
}

function inventoryEvidence() {
  return GCP_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS.map((kind) =>
    ['firewall', 'subnetwork', 'network', 'router', 'nat'].includes(kind)
      ? {
          kind,
          strategy: 'deterministic-name' as const,
          providerEvidenceRef: `gcp://inventory/${kind}`,
          deterministicNames: [`pc-host-1-${kind}`],
        }
      : {
          kind,
          strategy: 'managed-labels' as const,
          providerEvidenceRef: `gcp://inventory/${kind}`,
        },
  );
}

describe('GCP workspace-host safety preflight', () => {
  it('requires fresh quota, capacity, and price provenance before declaring ready', () => {
    const base = {
      requirements: [{ metric: 'compute.googleapis.com/cpus', minimumAvailable: 4, unit: 'cores' }],
      quotas: [
        {
          metric: 'compute.googleapis.com/cpus',
          limit: 24,
          usage: 8,
          unit: 'cores',
          observedAt: NOW,
          providerEvidenceRef: 'gcp://quota/us-central1/cpus',
        },
      ],
      capacity: {
        zone: 'us-central1-a',
        machineType: 'n2-standard-2',
        available: true,
        observedAt: NOW,
        providerEvidenceRef: 'gcp://capacity/us-central1-a/n2-standard-2',
      },
      price: {
        estimate: { currency: 'USD', hourlyAmount: 0.11, confidence: 'estimated' as const, observedAt: NOW },
        source: 'cloud-billing-catalog' as const,
        providerEvidenceRef: 'gcp://billing/catalog/2026-08-23',
        skuRefs: ['sku://gcp/n2-standard-2'],
        assumptions: ['sustained-use discounts excluded'],
      },
      evaluatedAt: NOW,
      maxEvidenceAgeMs: HOUR,
    };

    expect(evaluateGcpWorkspaceHostSafetyPreflight(base)).toMatchObject({ ready: true, issues: [] });
    expect(
      evaluateGcpWorkspaceHostSafetyPreflight({
        ...base,
        quotas: [{ ...base.quotas[0], limit: 10, usage: 8 }],
        capacity: { ...base.capacity, available: false, detail: 'zone stock exhausted' },
        price: { ...base.price, estimate: { ...base.price.estimate, confidence: 'unknown' as const } },
      }),
    ).toMatchObject({
      ready: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'quota-insufficient' }),
        expect.objectContaining({ code: 'capacity-unavailable' }),
        expect.objectContaining({ code: 'price-unknown' }),
      ]),
    });
  });

  it('fails closed when required provider evidence is missing or stale', () => {
    const report = evaluateGcpWorkspaceHostSafetyPreflight({
      requirements: [{ metric: 'compute.googleapis.com/cpus', minimumAvailable: 2, unit: 'cores' }],
      quotas: [],
      capacity: {
        zone: 'us-central1-a',
        machineType: 'n2-standard-2',
        available: true,
        observedAt: '2026-08-22T20:00:00.000Z',
        providerEvidenceRef: 'gcp://capacity/stale',
      },
      evaluatedAt: NOW,
      maxEvidenceAgeMs: HOUR,
    });
    expect(report.ready).toBe(false);
    expect(report.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['quota-unverified', 'evidence-stale', 'price-unverified']),
    );
  });
});

describe('GCP long-lived host runtime policy', () => {
  const freshSpend = {
    accruedCents: 100,
    pendingCents: 10,
    observedAt: NOW,
    providerEvidenceRef: 'gcp://billing/workspace-1',
  };

  it('stops idle compute without ever selecting data destruction', () => {
    expect(
      decideGcpWorkspaceHostRuntimeSafety({
        lifecycleState: 'running',
        lastActivityAt: '2026-08-22T21:00:00.000Z',
        spend: freshSpend,
        evaluatedAt: NOW,
        idleStopAfterMs: 2 * HOUR,
        hardSpendCents: 1_000,
        maxSpendEvidenceAgeMs: HOUR,
      }),
    ).toEqual({
      action: 'stop',
      stopInstance: true,
      blockStart: false,
      preserveData: true,
      evaluatedAt: NOW,
      reasons: ['idle-timeout'],
    });
  });

  it('stops and blocks starts at the hard ceiling or when spend is unverified', () => {
    const atCeiling = decideGcpWorkspaceHostRuntimeSafety({
      lifecycleState: 'running',
      spend: { ...freshSpend, accruedCents: 990 },
      evaluatedAt: NOW,
      idleStopAfterMs: HOUR,
      hardSpendCents: 1_000,
      maxSpendEvidenceAgeMs: HOUR,
    });
    expect(atCeiling).toMatchObject({
      action: 'stop-and-block-start',
      stopInstance: true,
      blockStart: true,
      preserveData: true,
      reasons: ['hard-spend-ceiling'],
    });

    expect(
      decideGcpWorkspaceHostRuntimeSafety({
        lifecycleState: 'stopped',
        evaluatedAt: NOW,
        idleStopAfterMs: HOUR,
        hardSpendCents: 1_000,
        maxSpendEvidenceAgeMs: HOUR,
      }),
    ).toMatchObject({ action: 'block-start', stopInstance: false, reasons: ['spend-unverified'] });
  });
});

describe('GCP managed-resource census and orphan reaper', () => {
  it('finds orphaned and mislabeled resources and plans guarded deletion after quarantine', () => {
    const vm = resource('vm', 'vm-1');
    const dataDisk = resource('disk', 'disk-orphan');
    const missingDisk = resource('disk', 'disk-expected');
    const census = censusGcpWorkspaceHostResources({
      hostId: 'host-1',
      workspaceId: 'workspace-1',
      expected: [vm, missingDisk],
      observed: [
        {
          resource: vm,
          labels: { ...labels(), [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'false' },
          observedAt: NOW,
        },
        {
          resource: dataDisk,
          labels: labels(),
          firstObservedAt: '2026-08-22T20:00:00.000Z',
          observedAt: NOW,
        },
        { resource: resource('vm', 'other-host'), labels: labels('host-2'), observedAt: NOW },
      ],
      inventoryEvidence: inventoryEvidence(),
      evaluatedAt: NOW,
      orphanGraceMs: 2 * HOUR,
    });

    expect(census.controllerIndependent).toBe(true);
    expect(census.inventoryComplete).toBe(true);
    expect(census.clean).toBe(false);
    expect(census.untracked.map(({ resource: entry }) => entry.providerId)).toEqual(['disk-orphan']);
    expect(census.labelMismatches.map(({ resource: entry }) => entry.providerId)).toEqual(['vm-1', 'other-host']);
    expect(census.missing.map((entry) => entry.providerId)).toEqual(['vm-1', 'disk-expected']);
    expect(census.reaperPlan).toEqual([
      expect.objectContaining({
        state: 'eligible',
        action: 'confirm-and-delete',
        preconditions: [
          'fresh-provider-read',
          'labels-still-match',
          'absent-from-controller-records',
          'durable-data-disposition',
          'provider-read-delete-confirmation',
        ],
      }),
    ]);
  });

  it('surfaces same-workspace resources owned by another host as defects without reaper ownership', () => {
    const ownedVm = resource('vm', 'vm-1');
    const foreignDisk = resource('disk', 'disk-other-host');
    const census = censusGcpWorkspaceHostResources({
      hostId: 'host-1',
      workspaceId: 'workspace-1',
      expected: [ownedVm],
      observed: [
        { resource: ownedVm, labels: labels(), observedAt: NOW },
        {
          resource: foreignDisk,
          labels: labels('host-2'),
          firstObservedAt: '2026-08-22T20:00:00.000Z',
          observedAt: NOW,
        },
      ],
      inventoryEvidence: inventoryEvidence(),
      evaluatedAt: NOW,
      orphanGraceMs: HOUR,
    });

    expect(census.clean).toBe(false);
    expect(census.labelMismatches.map(({ resource: entry }) => entry.providerId)).toEqual(['disk-other-host']);
    expect(census.untracked).toEqual([]);
    expect(census.reaperPlan).toEqual([]);
  });

  it.each([
    { name: 'another host', providerId: 'peer-disk', hostLabel: 'host-2', clean: true, mismatch: false },
    { name: 'a relabelled registered disk', providerId: 'registered-disk', hostLabel: 'host-2', clean: false, mismatch: true },
    { name: 'an unregistered owned disk', providerId: 'orphan-disk', hostLabel: 'host-1', clean: false, mismatch: false },
    { name: 'an unattributed workspace disk', providerId: 'unknown-disk', hostLabel: '', clean: false, mismatch: true },
  ])('scopes ordinary host inventory safely for $name', ({ providerId, hostLabel, clean, mismatch }) => {
    const observedDisk = resource('disk', providerId);
    const census = censusGcpWorkspaceHostResources({
      hostId: 'host-1',
      workspaceId: 'workspace-1',
      expected: [],
      registeredHostResources: [resource('disk', 'registered-disk')],
      observed: [{
        resource: observedDisk,
        labels: { ...labels(), [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: hostLabel },
        observedAt: NOW,
      }],
      inventoryEvidence: inventoryEvidence(),
      evaluatedAt: NOW,
      orphanGraceMs: HOUR,
    });

    expect(census.clean).toBe(clean);
    expect(census.labelMismatches.map(({ resource: entry }) => entry.providerId)).toEqual(mismatch ? [providerId] : []);
    expect(census.untracked.map(({ resource: entry }) => entry.providerId)).toEqual(hostLabel === 'host-1' ? [providerId] : []);
    expect(census.reaperPlan.map(({ resource: entry }) => entry.providerId)).toEqual(hostLabel === 'host-1' ? [providerId] : []);
  });

  it('keeps a registered snapshot recovery point as a retained survivor, never an orphan to reap (D-389)', () => {
    const observedSnapshots = ['backup-registered', 'backup-unregistered'].map((providerId) => ({
      resource: resource('snapshot', providerId),
      labels: labels(),
      observedAt: NOW,
    }));
    const census = (retained: readonly ReturnType<typeof resource>[], observed = observedSnapshots) =>
      censusGcpWorkspaceHostResources({
        hostId: 'host-1',
        workspaceId: 'workspace-1',
        expected: [],
        registeredHostResources: [],
        retained,
        observed,
        inventoryEvidence: inventoryEvidence(),
        evaluatedAt: NOW,
        orphanGraceMs: HOUR,
      });

    const withRetained = census([resource('snapshot', 'backup-registered')]);
    // CALIBRATION: the unregistered snapshot must STILL be an untracked, reapable finding — that is
    // the evidence of the pre-fix bug on older hosts, and it proves `retained` is not a blanket pass.
    expect(withRetained.untracked.map(({ resource: entry }) => entry.providerId)).toEqual(['backup-unregistered']);
    expect(withRetained.reaperPlan.map(({ resource: entry }) => entry.providerId)).toEqual(['backup-unregistered']);
    expect(withRetained.clean).toBe(false);

    // Only the registered one observed: clean, and nothing planned for deletion.
    const onlyRegistered = census([resource('snapshot', 'backup-registered')], [observedSnapshots[0]!]);
    expect(onlyRegistered.clean).toBe(true);
    expect(onlyRegistered.reaperPlan).toEqual([]);

    // A retained recovery point the user already deleted is not a `missing` finding (unlike `expected`).
    const deletedBackup = census([resource('snapshot', 'backup-registered')], []);
    expect(deletedBackup.missing).toEqual([]);
    expect(deletedBackup.clean).toBe(true);

    // `retained` can never be used to exempt a billable non-snapshot survivor.
    expect(() => census([resource('disk', 'backup-registered')])).toThrow(/must be a snapshot recovery point/);
  });

  it('requires non-vacuous all-kind inventory evidence and detects deterministic Router/NAT orphans', () => {
    const evidence = inventoryEvidence().map((entry) =>
      entry.kind === 'router'
        ? { ...entry, deterministicNames: ['pc-host-1-router'] }
        : entry.kind === 'nat'
          ? { ...entry, deterministicNames: ['pc-host-1-nat'] }
          : entry,
    );
    const base = {
      hostId: 'host-1',
      workspaceId: 'workspace-1',
      expected: [] as WorkspaceHostResourceRef[],
      observed: [
        { resource: resource('router', 'pc-host-1-router'), labels: {}, observedAt: NOW },
        { resource: resource('nat', 'pc-host-1-nat'), labels: {}, observedAt: NOW },
      ],
      evaluatedAt: NOW,
      orphanGraceMs: HOUR,
    };

    expect(() => censusGcpWorkspaceHostResources({ ...base, inventoryEvidence: evidence.slice(0, -1) })).toThrow(
      'inventory incomplete: nat',
    );
    const census = censusGcpWorkspaceHostResources({ ...base, inventoryEvidence: evidence });
    expect(census.clean).toBe(false);
    expect(census.untracked.map(({ resource: entry }) => `${entry.kind}:${entry.providerId}`)).toEqual([
      'router:pc-host-1-router',
      'nat:pc-host-1-nat',
    ]);
  });
});

describe('GCP ambiguous-operation recovery evidence', () => {
  const vm = resource('vm', 'vm-1');
  const base = {
    operationId: 'operation-1',
    idempotencyKey: 'operation-1:create-vm',
    attemptedAction: 'create' as const,
    resource: vm,
    hostId: 'host-1',
    workspaceId: 'workspace-1',
    actorId: 'operator-1',
    reason: 'provider timeout after request acceptance',
    issuedAt: NOW,
    maxEvidenceAgeMs: HOUR,
    providerRead: {
      resource: vm,
      state: 'running' as const,
      observedAt: NOW,
      providerEvidenceRef: 'gcp://compute/projects/project-1/zones/us-central1-a/instances/vm-1',
      providerRequestId: 'request-1',
      labels: labels(),
    },
  };

  it('closes only when a fresh provider read proves the attempted outcome', () => {
    expect(createGcpWorkspaceHostAmbiguousOperationRecoveryRecord(base)).toMatchObject({
      kind: 'gcp-workspace-host-ambiguous-operation-recovery',
      runbookRef: GCP_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
      closesOperation: true,
      nextAction: 'mark-step-applied',
    });
    expect(
      createGcpWorkspaceHostAmbiguousOperationRecoveryRecord({
        ...base,
        attemptedAction: 'delete',
        providerRead: { ...base.providerRead, state: 'running' },
      }),
    ).toMatchObject({
      closesOperation: false,
      nextAction: 'resume-reconcile-with-same-idempotency-key',
    });
  });

  it('rejects stale reads and secret-shaped provider evidence', () => {
    expect(() =>
      createGcpWorkspaceHostAmbiguousOperationRecoveryRecord({
        ...base,
        providerRead: { ...base.providerRead, observedAt: '2026-08-22T20:00:00.000Z' },
      }),
    ).toThrow('fresh, non-future provider read');
    expect(() =>
      createGcpWorkspaceHostAmbiguousOperationRecoveryRecord({
        ...base,
        providerEvidence: { accessToken: 'not-allowed' },
      }),
    ).toThrow('Secret-shaped field');
  });

  it('refuses to close a live resource whose managed identity labels do not match', () => {
    expect(() =>
      createGcpWorkspaceHostAmbiguousOperationRecoveryRecord({
        ...base,
        providerRead: { ...base.providerRead, labels: labels('another-host') },
      }),
    ).toThrow('exact managed host/workspace labels');
  });
});
