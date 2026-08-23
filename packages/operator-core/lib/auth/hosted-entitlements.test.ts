import { describe, expect, it } from 'vitest';
import {
  HOSTED_ENTITLEMENT_SCHEMA_VERSION,
  parseHostedEntitlementAssignment,
  parseHostedEntitlementBundle,
  parseHostedEntitlementOverride,
} from './hosted-entitlement-schema';
import {
  checkHostedEntitlement,
  resolveHostedEntitlements,
  type ResolvedHostedEntitlements,
} from './hosted-entitlements';

const NOW = new Date('2026-08-23T12:00:00.000Z');
const START = new Date('2026-08-01T00:00:00.000Z');
const END = new Date('2026-09-01T00:00:00.000Z');

function record(suffix: string, override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'private-beta',
    actor: { kind: 'staff', principalId: 'staff:beta-admin' },
    auditReceiptId: `audit:${suffix}`,
    effectiveFrom: START,
    effectiveUntil: END,
    ...override,
  };
}

function bundle(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
    bundleId: 'private-beta',
    bundleVersion: 3,
    entitlements: {
      allowedProviders: ['gcp'],
      limits: { workspaces: 2, members: 5 },
      browserAccess: { pty: true, files: false },
      supportTier: 'private-beta',
      quotas: { 'runtime.hours.monthly': 100, 'storage.gib': 250 },
      budgets: { 'cloud.usd_cents.monthly': 50_000 },
      rolloutFlags: { 'hosted.console': true, 'hosted.snapshots': false },
    },
    record: record('bundle'),
    ...override,
  };
}

function assignment(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
    assignmentId: 'assignment:org-1',
    organizationId: 'org-1',
    bundleId: 'private-beta',
    bundleVersion: 3,
    record: record('assignment'),
    ...override,
  };
}

function entitlementOverride(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: HOSTED_ENTITLEMENT_SCHEMA_VERSION,
    overrideId: 'override:expanded-beta',
    overrideVersion: 1,
    organizationId: 'org-1',
    bundleId: 'private-beta',
    bundleVersion: 3,
    precedence: 10,
    patch: {
      allowedProviders: ['gcp', 'aws'],
      limits: { workspaces: 4 },
      browserAccess: { files: true },
      supportTier: 'priority-beta',
      quotas: { 'runtime.hours.monthly': 250, 'storage.gib': null },
      budgets: { 'cloud.usd_cents.monthly': 100_000 },
      rolloutFlags: { 'hosted.snapshots': true },
    },
    record: record('override'),
    ...override,
  };
}

function resolve(override: Partial<Parameters<typeof resolveHostedEntitlements>[0]> = {}) {
  return resolveHostedEntitlements({
    organizationId: 'org-1',
    at: NOW,
    bundles: [bundle()],
    assignments: [assignment()],
    overrides: [],
    ...override,
  });
}

function resolved(override: Partial<Parameters<typeof resolveHostedEntitlements>[0]> = {}) {
  const result = resolve(override);
  if (!result.ok) throw new Error(`expected resolution, got ${result.reason}`);
  return result.value;
}

describe('hosted entitlement persisted schema', () => {
  it('accepts the complete payment-independent bundle and normalizes ISO timestamps', () => {
    const result = parseHostedEntitlementBundle(
      bundle({
        record: record('bundle-json', {
          effectiveFrom: START.toISOString(),
          effectiveUntil: END.toISOString(),
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issue.message);
    expect(result.value).toMatchObject({
      schemaVersion: 1,
      bundleId: 'private-beta',
      bundleVersion: 3,
      entitlements: {
        allowedProviders: ['gcp'],
        limits: { workspaces: 2, members: 5 },
        browserAccess: { pty: true, files: false },
        supportTier: 'private-beta',
      },
      record: {
        source: 'private-beta',
        actor: { kind: 'staff', principalId: 'staff:beta-admin' },
        auditReceiptId: 'audit:bundle-json',
      },
    });
    expect(result.value.record.effectiveFrom).toEqual(START);
  });

  it('pins assignments and overrides to exact positive bundle/revision versions', () => {
    expect(parseHostedEntitlementAssignment(assignment()).ok).toBe(true);
    expect(parseHostedEntitlementOverride(entitlementOverride()).ok).toBe(true);

    expect(parseHostedEntitlementAssignment(assignment({ bundleVersion: 0 }))).toMatchObject({
      ok: false,
      issue: { path: '$.bundleVersion' },
    });
    expect(parseHostedEntitlementOverride(entitlementOverride({ overrideVersion: 0 }))).toMatchObject({
      ok: false,
      issue: { path: '$.overrideVersion' },
    });
  });

  it.each([
    ['unknown top-level authority field', bundle({ stripeCustomerId: 'cus_secret' }), '$.stripeCustomerId'],
    [
      'unknown provider',
      bundle({
        entitlements: {
          ...(bundle().entitlements as object),
          allowedProviders: ['gcp', 'unknown-cloud'],
        },
      }),
      '$.entitlements.allowedProviders[1]',
    ],
    [
      'non-finite quota',
      bundle({
        entitlements: {
          ...(bundle().entitlements as object),
          quotas: { 'runtime.hours.monthly': Number.NaN },
        },
      }),
      '$.entitlements.quotas.runtime.hours.monthly',
    ],
    [
      'reversed interval',
      bundle({ record: record('reversed', { effectiveFrom: END, effectiveUntil: START }) }),
      '$.record.effectiveUntil',
    ],
  ] as const)('rejects %s instead of partially accepting it', (_label, candidate, path) => {
    expect(parseHostedEntitlementBundle(candidate)).toMatchObject({
      ok: false,
      issue: { path },
    });
  });

  it('requires a distinct staff principal for private-beta seeds and staff overrides', () => {
    const serviceRecord = record('bad-actor', {
      actor: { kind: 'service', principalId: 'service:hosted' },
    });
    expect(parseHostedEntitlementAssignment(assignment({ record: serviceRecord }))).toMatchObject({
      ok: false,
      issue: {
        path: '$.record.actor.kind',
        message: expect.stringContaining('distinct staff principal'),
      },
    });
  });

  it('allows service-authored billing/migration records without introducing payment fields', () => {
    const result = parseHostedEntitlementBundle(
      bundle({
        record: record('migration', {
          source: 'migration',
          actor: { kind: 'service', principalId: 'service:hosted-migration' },
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty override patch and unknown nested fields', () => {
    expect(parseHostedEntitlementOverride(entitlementOverride({ patch: {} }))).toMatchObject({
      ok: false,
      issue: { path: '$.patch' },
    });
    expect(
      parseHostedEntitlementOverride(
        entitlementOverride({
          patch: { limits: { workspaces: 2, secretLimit: 3 } },
        }),
      ),
    ).toMatchObject({
      ok: false,
      issue: { path: '$.patch.limits.secretLimit' },
    });
  });
});

describe('resolveHostedEntitlements', () => {
  it('resolves one active organization assignment to its exact bundle version', () => {
    const value = resolved({
      bundles: [bundle(), bundle({ bundleVersion: 4 })],
      assignments: [
        assignment(),
        assignment({
          assignmentId: 'assignment:org-2',
          organizationId: 'org-2',
        }),
      ],
    });

    expect(value).toMatchObject({
      organizationId: 'org-1',
      assignmentId: 'assignment:org-1',
      bundleId: 'private-beta',
      bundleVersion: 3,
      allowedProviders: ['gcp'],
      limits: { workspaces: 2, members: 5 },
      browserAccess: { pty: true, files: false },
      auditReceiptIds: ['audit:bundle', 'audit:assignment'],
      appliedOverrides: [],
    });
    expect(value.recheckAt).toEqual(END);
  });

  it('fails closed for absent, overlapping, missing, duplicate, or inactive authority', () => {
    expect(resolve({ assignments: [] })).toMatchObject({ ok: false, reason: 'no_active_assignment' });
    expect(
      resolve({
        assignments: [assignment(), assignment({ assignmentId: 'assignment:second' })],
      }),
    ).toMatchObject({ ok: false, reason: 'ambiguous_active_assignments' });
    expect(resolve({ bundles: [] })).toMatchObject({ ok: false, reason: 'bundle_not_found' });
    expect(resolve({ bundles: [bundle(), bundle()] })).toMatchObject({
      ok: false,
      reason: 'ambiguous_bundle',
    });
    expect(
      resolve({
        bundles: [bundle({ record: record('expired', { effectiveUntil: NOW }) })],
      }),
    ).toMatchObject({ ok: false, reason: 'bundle_inactive' });
  });

  it('fails closed on any malformed supplied record, even one claiming another organization', () => {
    const malformedForeign = assignment({
      assignmentId: 'assignment:foreign',
      organizationId: 'org-2',
      record: { ...record('foreign'), unexpectedAuthority: true },
    });
    expect(resolve({ assignments: [assignment(), malformedForeign] })).toMatchObject({
      ok: false,
      reason: 'invalid_assignment_record',
      recordIndex: 1,
      issue: { path: '$.record.unexpectedAuthority' },
    });
  });

  it('applies active overrides in precedence order and records exact provenance', () => {
    const first = entitlementOverride();
    const second = entitlementOverride({
      overrideId: 'override:emergency-tighten',
      precedence: 20,
      patch: {
        allowedProviders: [],
        limits: { workspaces: 1 },
        quotas: { 'runtime.hours.monthly': 25 },
        budgets: { 'cloud.usd_cents.monthly': null },
        rolloutFlags: { 'hosted.console': false },
      },
      record: record('tighten'),
    });

    const value = resolved({ overrides: [second, first] });
    expect(value).toMatchObject({
      allowedProviders: [],
      limits: { workspaces: 1, members: 5 },
      browserAccess: { pty: true, files: true },
      supportTier: 'priority-beta',
      quotas: { 'runtime.hours.monthly': 25 },
      budgets: {},
      rolloutFlags: { 'hosted.console': false, 'hosted.snapshots': true },
      appliedOverrides: [
        { overrideId: 'override:expanded-beta', overrideVersion: 1 },
        { overrideId: 'override:emergency-tighten', overrideVersion: 1 },
      ],
      auditReceiptIds: ['audit:bundle', 'audit:assignment', 'audit:override', 'audit:tighten'],
    });
  });

  it('uses the latest active version of one override and rechecks at future boundaries', () => {
    const version1 = entitlementOverride();
    const version2 = entitlementOverride({
      overrideVersion: 2,
      patch: { limits: { workspaces: 6 } },
      record: record('override-v2'),
    });
    const future = entitlementOverride({
      overrideId: 'override:future',
      precedence: 20,
      patch: { limits: { members: 10 } },
      record: record('future', {
        effectiveFrom: new Date('2026-08-24T00:00:00.000Z'),
        effectiveUntil: null,
      }),
    });

    const value = resolved({ overrides: [version1, version2, future] });
    expect(value.limits.workspaces).toBe(6);
    expect(value.appliedOverrides).toEqual([{ overrideId: 'override:expanded-beta', overrideVersion: 2 }]);
    expect(value.recheckAt).toEqual(new Date('2026-08-24T00:00:00.000Z'));
  });

  it('rejects duplicate active revisions and ambiguous precedence instead of tie-breaking', () => {
    expect(
      resolve({
        overrides: [entitlementOverride(), entitlementOverride()],
      }),
    ).toMatchObject({ ok: false, reason: 'ambiguous_override_revision' });

    expect(
      resolve({
        overrides: [entitlementOverride(), entitlementOverride({ overrideId: 'override:other' })],
      }),
    ).toMatchObject({ ok: false, reason: 'ambiguous_override_precedence' });
  });

  it('ignores expired overrides and overrides pinned to a different bundle version', () => {
    const value = resolved({
      overrides: [
        entitlementOverride({
          record: record('expired-override', { effectiveUntil: NOW }),
        }),
        entitlementOverride({
          overrideId: 'override:future-bundle',
          bundleVersion: 4,
        }),
      ],
    });
    expect(value.appliedOverrides).toEqual([]);
    expect(value.limits.workspaces).toBe(2);
  });
});

describe('checkHostedEntitlement', () => {
  const value = (): ResolvedHostedEntitlements =>
    resolved({
      overrides: [entitlementOverride()],
    });

  it.each([
    [{ kind: 'provider', provider: 'aws' }, true, 'entitled'],
    [{ kind: 'provider', provider: 'azure' }, false, 'provider_not_allowed'],
    [{ kind: 'workspace-limit', current: 3 }, true, 'entitled'],
    [{ kind: 'workspace-limit', current: 4 }, false, 'workspace_limit_exceeded'],
    [{ kind: 'member-limit', current: 4 }, true, 'entitled'],
    [{ kind: 'member-limit', current: 5 }, false, 'member_limit_exceeded'],
    [{ kind: 'browser-pty' }, true, 'entitled'],
    [{ kind: 'browser-files' }, true, 'entitled'],
    [{ kind: 'quota', key: 'runtime.hours.monthly', used: 249, requested: 1 }, true, 'entitled'],
    [{ kind: 'quota', key: 'runtime.hours.monthly', used: 250, requested: 1 }, false, 'quota_exceeded'],
    [{ kind: 'quota', key: 'missing', used: 0 }, false, 'quota_missing'],
    [{ kind: 'budget', key: 'cloud.usd_cents.monthly', used: 99_999, requested: 1 }, true, 'entitled'],
    [{ kind: 'budget', key: 'missing', used: 0 }, false, 'budget_missing'],
    [{ kind: 'rollout-flag', key: 'hosted.snapshots' }, true, 'entitled'],
    [{ kind: 'rollout-flag', key: 'unknown' }, false, 'rollout_flag_disabled'],
  ] as const)('checks %j without ambient fallback', (gate, allowed, reason) => {
    expect(checkHostedEntitlement(value(), gate)).toMatchObject({
      allowed,
      reason,
      audit: {
        organizationId: 'org-1',
        assignmentId: 'assignment:org-1',
        bundleId: 'private-beta',
        bundleVersion: 3,
        gate: gate.kind,
      },
    });
  });

  it('fails closed for malformed counters instead of treating NaN or negatives as zero', () => {
    expect(
      checkHostedEntitlement(value(), {
        kind: 'workspace-limit',
        current: -1,
      }),
    ).toMatchObject({ allowed: false, reason: 'invalid_gate_input' });
    expect(
      checkHostedEntitlement(value(), {
        kind: 'budget',
        key: 'cloud.usd_cents.monthly',
        used: Number.NaN,
      }),
    ).toMatchObject({ allowed: false, reason: 'invalid_gate_input' });
  });
});
