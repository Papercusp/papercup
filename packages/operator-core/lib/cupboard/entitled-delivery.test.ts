import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PINNING_POLICY,
  type ArtifactDistributionState,
  type DistributionSource,
} from '../p2p/artifact-distribution';
import type { CommerceEvent } from '../p2p/commerce-events';
import { listingManifestSigningBytes, type CupboardReleaseManifest } from './listing-manifest';
import { cupboardArtifactKey, memoryArtifactStore } from './artifact-store';
import {
  authorizeDelivery,
  lookupEntitlement,
  planInstall,
  planRollback,
  projectEntitlements,
  releaseRef,
  resolveDependencyOrder,
  verifySignedPackage,
  type DependencyGraph,
  type InstalledRelease,
} from './entitled-delivery';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function manifest(over: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest {
  return {
    schemaVersion: 1,
    listingKind: 'pack',
    listingRef: 'tools',
    releaseVersion: '1.0.0',
    contentHash: HASH_A,
    signature: 'sig',
    dependencies: [],
    compatibility: { runtime: 'node>=22' },
    permissions: ['fs:read'],
    capabilities: [],
    license: 'MIT',
    publisher: { githubUserId: 42, login: 'alice' },
    reviewStatus: 'approved',
    ...over,
  };
}

function source(over: Partial<DistributionSource> = {}): DistributionSource {
  return {
    sourceId: 'src-1',
    class: 'pinner',
    providerId: 'memory',
    locator: 'opaque',
    advertisedAtMs: 1_000,
    expiresAtMs: null,
    ...over,
  };
}

function distribution(over: Partial<ArtifactDistributionState> = {}): ArtifactDistributionState {
  const release = manifest();
  return {
    streamId: 'stream-1',
    manifest: {
      schemaVersion: 1,
      release,
      rootHash: release.contentHash,
      totalSizeBytes: 10,
      chunks: [],
      visibility: 'public',
      encryption: null,
      pinning: DEFAULT_PINNING_POLICY,
      signature: 'dist-sig',
    },
    sources: [source()],
    pins: ['src-1'],
    keyVersion: 1,
    revokedKeyVersions: [],
    yankedAtMs: null,
    yankReason: null,
    lastSequence: 1,
    ...over,
  };
}

let nextSequence = 1;
function commerceEvent(
  kind: CommerceEvent['kind'],
  payload: Record<string, unknown>,
  over: Partial<CommerceEvent> = {},
): CommerceEvent {
  const sequence = over.sequence ?? nextSequence++;
  return {
    eventId: over.eventId ?? `evt-${kind}-${sequence}`,
    streamId: 'commerce-1',
    kind,
    version: 1,
    issuer: 'seller',
    sequence,
    occurredAtMs: over.occurredAtMs ?? 5_000,
    idempotencyKey: over.idempotencyKey ?? `idem-${sequence}`,
    payload,
    signature: 'sig',
  };
}

const REF = releaseRef(manifest());

function entitledTo(ref = REF, over: Record<string, unknown> = {}) {
  return projectEntitlements([
    commerceEvent('entitlement', {
      entitlementId: 'ent-1',
      subject: 'buyer-1',
      releaseRef: ref,
      ...over,
    }),
  ]);
}

describe('projectEntitlements', () => {
  it('folds a grant and finds it by subject + release', () => {
    const projection = entitledTo();
    const grant = lookupEntitlement(projection, 'buyer-1', REF);
    expect(grant).toMatchObject({ entitlementId: 'ent-1', subject: 'buyer-1', revokedAtMs: null });
    expect(projection.unusable).toEqual([]);
  });

  it('is order-independent — a shuffled batch folds to the same view', () => {
    const grant = commerceEvent('entitlement', {
      entitlementId: 'ent-1',
      subject: 'buyer-1',
      releaseRef: REF,
    }, { sequence: 1 });
    const refund = commerceEvent('refund', { entitlementId: 'ent-1', reason: 'chargeback' }, { sequence: 2 });

    const forward = projectEntitlements([grant, refund]);
    const reversed = projectEntitlements([refund, grant]);

    expect(lookupEntitlement(forward, 'buyer-1', REF)?.revokedAtMs).not.toBeNull();
    expect(lookupEntitlement(reversed, 'buyer-1', REF)?.revokedAtMs).not.toBeNull();
    expect(lookupEntitlement(reversed, 'buyer-1', REF)?.revokedReason).toBe('chargeback');
  });

  it('keeps revocation TERMINAL — a replayed grant cannot resurrect a refunded entitlement', () => {
    // The failure this guards: replaying the event log re-applies the original
    // grant after the refund and silently restores delivery to a refunded buyer.
    const grant = commerceEvent('entitlement', {
      entitlementId: 'ent-1',
      subject: 'buyer-1',
      releaseRef: REF,
    }, { sequence: 1 });
    const refund = commerceEvent('refund', { entitlementId: 'ent-1' }, { sequence: 2 });
    const replayed = { ...grant, eventId: 'evt-replay', sequence: 3 };

    const projection = projectEntitlements([grant, refund, replayed]);
    expect(lookupEntitlement(projection, 'buyer-1', REF)?.revokedAtMs).not.toBeNull();
  });

  it('records a refund whose grant is absent instead of silently ignoring it', () => {
    const projection = projectEntitlements([commerceEvent('refund', { entitlementId: 'ghost' })]);
    expect(projection.grants.size).toBe(0);
    expect(projection.unusable).toHaveLength(1);
    expect(projection.unusable[0]!.reason).toContain('ghost');
  });

  it('does not confuse two subjects, or one subject across two releases', () => {
    const other = releaseRef(manifest({ releaseVersion: '2.0.0' }));
    const projection = projectEntitlements([
      commerceEvent('entitlement', { entitlementId: 'e1', subject: 'buyer-1', releaseRef: REF }),
      commerceEvent('entitlement', { entitlementId: 'e2', subject: 'buyer-2', releaseRef: REF }),
      commerceEvent('entitlement', { entitlementId: 'e3', subject: 'buyer-1', releaseRef: other }),
    ]);
    expect(lookupEntitlement(projection, 'buyer-1', REF)?.entitlementId).toBe('e1');
    expect(lookupEntitlement(projection, 'buyer-2', REF)?.entitlementId).toBe('e2');
    expect(lookupEntitlement(projection, 'buyer-1', other)?.entitlementId).toBe('e3');
    expect(lookupEntitlement(projection, 'buyer-2', other)).toBeNull();
  });
});

describe('authorizeDelivery — entitlement gate', () => {
  const base = { manifest: manifest(), distribution: distribution(), nowMs: 10_000 } as const;

  it('refuses a subject with no entitlement, and leaks no source information', () => {
    const decision = authorizeDelivery({
      ...base,
      subject: 'stranger',
      entitlements: entitledTo(),
      intent: 'install',
    });
    expect(decision.deliverable).toBe(false);
    expect(decision.code).toBe('no-entitlement');
    expect(decision.sources).toEqual([]);
    expect(decision.pinHealth).toBeNull();
  });

  it('FAILS CLOSED when a free release is not declared free', () => {
    // A caller that forgets `freeRelease` must refuse, never give bytes away.
    expect(
      authorizeDelivery({ ...base, subject: 'anyone', entitlements: projectEntitlements([]), intent: 'install' }).code,
    ).toBe('no-entitlement');
    expect(
      authorizeDelivery({
        ...base,
        subject: 'anyone',
        entitlements: projectEntitlements([]),
        intent: 'install',
        freeRelease: true,
      }).deliverable,
    ).toBe(true);
  });

  it('refuses a revoked or expired entitlement', () => {
    const revoked = projectEntitlements([
      commerceEvent('entitlement', { entitlementId: 'e1', subject: 'buyer-1', releaseRef: REF }, { sequence: 1 }),
      commerceEvent('refund', { entitlementId: 'e1' }, { sequence: 2 }),
    ]);
    expect(authorizeDelivery({ ...base, subject: 'buyer-1', entitlements: revoked, intent: 'install' }).code).toBe(
      'entitlement-revoked',
    );

    const expired = entitledTo(REF, { expiresAtMs: 9_000 });
    expect(authorizeDelivery({ ...base, subject: 'buyer-1', entitlements: expired, intent: 'install' }).code).toBe(
      'entitlement-expired',
    );
  });

  it('refuses a release that is not review-approved', () => {
    expect(
      authorizeDelivery({
        ...base,
        manifest: manifest({ reviewStatus: 'pending' }),
        subject: 'buyer-1',
        entitlements: entitledTo(),
        intent: 'install',
      }).code,
    ).toBe('review-not-approved');
  });

  it('allows an entitled install and returns sources best-first', () => {
    const state = distribution({
      sources: [source({ sourceId: 'cache-1', class: 'cache' }), source({ sourceId: 'pin-1', class: 'pinner' })],
      pins: ['pin-1'],
    });
    const decision = authorizeDelivery({
      ...base,
      distribution: state,
      subject: 'buyer-1',
      entitlements: entitledTo(),
      intent: 'install',
    });
    expect(decision.deliverable).toBe(true);
    expect(decision.sources.map((s) => s.sourceId)).toEqual(['pin-1', 'cache-1']);
  });
});

describe('authorizeDelivery — yanked-version behavior', () => {
  const yanked = distribution({ yankedAtMs: 10_000, yankReason: 'bad build' });
  const entitlements = entitledTo();

  it('refuses a NEW install and an UPDATE of a yanked release', () => {
    for (const intent of ['install', 'update'] as const) {
      const decision = authorizeDelivery({
        subject: 'buyer-1',
        manifest: manifest(),
        distribution: yanked,
        entitlements,
        intent,
        nowMs: 11_000,
      });
      expect(decision.deliverable).toBe(false);
      expect(decision.code).toBe('release-yanked');
      expect(decision.detail).toContain('bad build');
    }
  });

  it('STILL SERVES a repair of an already-installed yanked version inside retention', () => {
    // The other half of D-007. A yank withdraws a version from new acquisition;
    // it must not remotely brick software already on someone's disk, which is
    // exactly why pinners retain bytes for yankRetentionMs.
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: yanked,
      entitlements,
      intent: 'repair',
      nowMs: 11_000,
    });
    expect(decision.deliverable).toBe(true);
    expect(decision.servingYankedForExistingInstall).toBe(true);
    expect(decision.sources).not.toEqual([]);
  });

  it('stops serving a repair once the retention window closes', () => {
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: yanked,
      entitlements,
      intent: 'repair',
      nowMs: 10_000 + DEFAULT_PINNING_POLICY.yankRetentionMs + 1,
    });
    expect(decision.deliverable).toBe(false);
    expect(decision.code).toBe('yank-retention-expired');
  });

  it('keeps entitlement revocation TERMINAL even for a repair — unlike a yank', () => {
    // The asymmetry that makes the repair exemption safe: a yank is the
    // publisher withdrawing a version, a revocation is the buyer's right ending.
    const revoked = projectEntitlements([
      commerceEvent('entitlement', { entitlementId: 'e1', subject: 'buyer-1', releaseRef: REF }, { sequence: 1 }),
      commerceEvent('reversal', { entitlementId: 'e1' }, { sequence: 2 }),
    ]);
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: yanked,
      entitlements: revoked,
      intent: 'repair',
      nowMs: 11_000,
    });
    expect(decision.deliverable).toBe(false);
    expect(decision.code).toBe('entitlement-revoked');
  });

  it('refuses a repair when a yanked release has no surviving source', () => {
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: distribution({ yankedAtMs: 10_000, sources: [], pins: [] }),
      entitlements,
      intent: 'repair',
      nowMs: 11_000,
    });
    expect(decision.deliverable).toBe(false);
    expect(decision.code).toBe('no-sources');
  });

  it('refuses a revoked key version for a private release', () => {
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: distribution({ revokedKeyVersions: [3] }),
      entitlements: entitledTo(REF, { keyVersion: 3 }),
      intent: 'install',
      nowMs: 11_000,
    });
    expect(decision.deliverable).toBe(false);
    expect(decision.code).toBe('key-revoked');
  });

  it('refuses an offline client holding no pin', () => {
    const decision = authorizeDelivery({
      subject: 'buyer-1',
      manifest: manifest(),
      distribution: distribution({ sources: [source({ sourceId: 'far' })], pins: [] }),
      entitlements,
      intent: 'install',
      nowMs: 11_000,
      offline: true,
    });
    expect(decision.code).toBe('offline-no-pin');
  });
});

describe('verifySignedPackage', () => {
  function storeWith(hash: string) {
    const store = memoryArtifactStore();
    // `put` takes an ArtifactRef and derives the content-addressed storage key
    // itself — passing a storageKey would be asserting the key the store is
    // responsible for computing.
    store.put({ contentHash: hash, sizeBytes: 10, contentType: 'application/octet-stream' });
    return store;
  }
  const accept = () => true;

  it('accepts a well-formed, correctly signed manifest backed by real bytes', async () => {
    const result = await verifySignedPackage(
      { store: storeWith(HASH_A), verifySignature: accept },
      { manifest: manifest(), expected: { listingKind: 'pack', listingRef: 'tools', releaseVersion: '1.0.0' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.storageKey).toBe(cupboardArtifactKey(HASH_A));
      expect(result.sizeBytes).toBe(10);
    }
  });

  it('signs over the manifest WITHOUT its signature field', async () => {
    let seen: Buffer | null = null;
    await verifySignedPackage(
      {
        store: storeWith(HASH_A),
        verifySignature: ({ signingBytes }) => {
          seen = signingBytes;
          return true;
        },
      },
      { manifest: manifest(), expected: { listingKind: 'pack', listingRef: 'tools', releaseVersion: '1.0.0' } },
    );
    const { signature: _drop, ...unsigned } = manifest();
    void _drop;
    expect(seen).not.toBeNull();
    expect(seen!.equals(listingManifestSigningBytes(unsigned))).toBe(true);
  });

  it('REJECTS a valid, correctly signed manifest for a DIFFERENT release', async () => {
    // The substitution attack: every individual check passes, and only the
    // identity comparison against what the caller ASKED for catches it.
    const result = await verifySignedPackage(
      { store: storeWith(HASH_A), verifySignature: accept },
      { manifest: manifest(), expected: { listingKind: 'pack', listingRef: 'tools', releaseVersion: '2.0.0' } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('release-identity-mismatch');
      expect(result.detail).toContain('2.0.0');
    }
  });

  it('refuses a failed signature, a malformed manifest, and missing bytes', async () => {
    const expected = { listingKind: 'pack', listingRef: 'tools', releaseVersion: '1.0.0' } as const;

    const badSig = await verifySignedPackage(
      { store: storeWith(HASH_A), verifySignature: () => false },
      { manifest: manifest(), expected },
    );
    expect(badSig.ok ? null : badSig.code).toBe('signature-invalid');

    const malformed = await verifySignedPackage(
      { store: storeWith(HASH_A), verifySignature: accept },
      { manifest: { schemaVersion: 2 }, expected },
    );
    expect(malformed.ok ? null : malformed.code).toBe('manifest-invalid');

    const noBytes = await verifySignedPackage(
      { store: storeWith(HASH_B), verifySignature: accept },
      { manifest: manifest(), expected },
    );
    expect(noBytes.ok ? null : noBytes.code).toBe('missing-artifact');

    const wrongSize = await verifySignedPackage(
      { store: storeWith(HASH_A), verifySignature: accept },
      { manifest: manifest(), expected, expectedSizeBytes: 999 },
    );
    expect(wrongSize.ok ? null : wrongSize.code).toBe('size-mismatch');
  });

  it('checks the signature BEFORE trusting the manifest is well-formed', async () => {
    // A malformed manifest must never reach the signature verifier at all.
    let called = false;
    await verifySignedPackage(
      {
        store: storeWith(HASH_A),
        verifySignature: () => {
          called = true;
          return true;
        },
      },
      { manifest: { nope: true }, expected: { listingKind: 'pack', listingRef: 'tools', releaseVersion: '1.0.0' } },
    );
    expect(called).toBe(false);
  });
});

describe('resolveDependencyOrder', () => {
  const graph = (edges: Record<string, string[]>): DependencyGraph => ({
    edges: new Map(Object.entries(edges)),
  });

  it('orders every dependency before its dependent, root last', () => {
    const result = resolveDependencyOrder('app', graph({ app: ['lib-a', 'lib-b'], 'lib-a': ['core'], 'lib-b': ['core'], core: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const at = (ref: string) => result.order.indexOf(ref);
    expect(at('core')).toBeLessThan(at('lib-a'));
    expect(at('core')).toBeLessThan(at('lib-b'));
    expect(at('lib-a')).toBeLessThan(at('app'));
    expect(result.order[result.order.length - 1]).toBe('app');
    // A diamond installs the shared dependency exactly once.
    expect(result.order.filter((r) => r === 'core')).toHaveLength(1);
  });

  it('is deterministic regardless of sibling declaration order', () => {
    const forward = resolveDependencyOrder('app', graph({ app: ['x', 'y'], x: [], y: [] }));
    const reversed = resolveDependencyOrder('app', graph({ app: ['y', 'x'], x: [], y: [] }));
    expect(forward.ok && reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) expect(forward.order).toEqual(reversed.order);
  });

  it('REFUSES a cycle and names the exact chain', () => {
    const result = resolveDependencyOrder('a', graph({ a: ['b'], b: ['c'], c: ['a'] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cycle');
    expect(result.path).toEqual(['a', 'b', 'c', 'a']);
  });

  it('refuses a dependency with no manifest rather than skipping it', () => {
    const result = resolveDependencyOrder('app', graph({ app: ['ghost'] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing');
    expect(result.path).toEqual(['app', 'ghost']);
  });
});

describe('planInstall / planRollback', () => {
  const graph: DependencyGraph = new Map<string, readonly string[]>([
    ['pack:tools:1.0.0', ['pack:core:1.0.0']],
    ['pack:tools:2.0.0', ['pack:core:1.0.0']],
    ['pack:core:1.0.0', []],
  ]) as unknown as DependencyGraph;
  const g: DependencyGraph = { edges: (graph as unknown as Map<string, readonly string[]>) };

  const installed = (entries: [string, string][]): ReadonlyMap<string, InstalledRelease> =>
    new Map(entries.map(([ref, hash]) => [ref, { releaseRef: ref, installedAtMs: 1, contentHash: hash }]));

  it('plans a fresh install with dependencies first', () => {
    const plan = planInstall({ target: 'pack:tools:1.0.0', graph: g, installed: installed([]) });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operation).toBe('install');
    expect(plan.steps.map((s) => s.releaseRef)).toEqual(['pack:core:1.0.0', 'pack:tools:1.0.0']);
    expect(plan.steps.every((s) => s.intent === 'install')).toBe(true);
    expect(plan.rollbackTo).toBeNull();
  });

  it('marks an already-installed dependency a REPAIR so a yank cannot block the upgrade', () => {
    // The practical consequence: upgrading tools 1.0.0 → 2.0.0 must not fail
    // just because the shared core dependency was yanked in the meantime — that
    // dependency is already on disk and is only being re-verified.
    const plan = planInstall({
      target: 'pack:tools:2.0.0',
      graph: g,
      installed: installed([['pack:core:1.0.0', HASH_B], ['pack:tools:1.0.0', HASH_A]]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operation).toBe('update');
    const core = plan.steps.find((s) => s.releaseRef === 'pack:core:1.0.0');
    const target = plan.steps.find((s) => s.releaseRef === 'pack:tools:2.0.0');
    expect(core).toMatchObject({ intent: 'repair', alreadySatisfied: true });
    expect(target).toMatchObject({ intent: 'update', alreadySatisfied: false });
    expect(plan.rollbackTo?.releaseRef).toBe('pack:tools:1.0.0');
  });

  it('detects a true no-op when the exact bytes are already installed', () => {
    const plan = planInstall({
      target: 'pack:tools:1.0.0',
      graph: g,
      installed: installed([['pack:core:1.0.0', HASH_B], ['pack:tools:1.0.0', HASH_A]]),
      targetContentHash: HASH_A,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operation).toBe('no-op');
    expect(plan.steps.every((s) => s.alreadySatisfied)).toBe(true);
  });

  it('treats a CHANGED content hash at the same version as work, not a no-op', () => {
    const plan = planInstall({
      target: 'pack:tools:1.0.0',
      graph: g,
      installed: installed([['pack:core:1.0.0', HASH_B], ['pack:tools:1.0.0', HASH_B]]),
      targetContentHash: HASH_A,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operation).not.toBe('no-op');
  });

  it('rolls back only to a version actually installed here, as a REPAIR', () => {
    const plan = planRollback({
      target: 'pack:tools:1.0.0',
      graph: g,
      installed: installed([['pack:core:1.0.0', HASH_B], ['pack:tools:1.0.0', HASH_A]]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.operation).toBe('rollback');
    expect(plan.steps.every((s) => s.intent === 'repair')).toBe(true);
  });

  it('REFUSES to re-acquire a never-installed version through the rollback door', () => {
    // Without this, a yanked release becomes reachable again by calling it a
    // rollback: rollback steps are `repair`, which authorizeDelivery permits.
    const plan = planRollback({ target: 'pack:tools:1.0.0', graph: g, installed: installed([]) });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe('rollback-target-not-installed');
    expect(plan.detail).toContain('planInstall');
  });

  it('propagates a dependency cycle as a planning failure', () => {
    const cyclic: DependencyGraph = { edges: new Map([['a', ['b']], ['b', ['a']]]) };
    const plan = planInstall({ target: 'a', graph: cyclic, installed: installed([]) });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe('cycle');
  });
});

describe('install plan feeds delivery authorization end to end', () => {
  it('a yanked dependency blocks a NEW install but not an upgrade that already has it', () => {
    const g: DependencyGraph = {
      edges: new Map([
        ['pack:tools:2.0.0', ['pack:core:1.0.0']],
        ['pack:core:1.0.0', []],
      ]),
    };
    const coreManifest = manifest({ listingRef: 'core', releaseVersion: '1.0.0' });
    const coreRef = releaseRef(coreManifest);
    const yankedCore = distribution({ yankedAtMs: 10_000, yankReason: 'cve' });
    const entitlements = projectEntitlements([
      commerceEvent('entitlement', { entitlementId: 'e1', subject: 'buyer-1', releaseRef: coreRef }),
    ]);

    const fresh = planInstall({ target: 'pack:tools:2.0.0', graph: g, installed: new Map() });
    const upgrade = planInstall({
      target: 'pack:tools:2.0.0',
      graph: g,
      installed: new Map([
        [coreRef, { releaseRef: coreRef, installedAtMs: 1, contentHash: HASH_A }],
      ]),
    });
    expect(fresh.ok && upgrade.ok).toBe(true);
    if (!fresh.ok || !upgrade.ok) return;

    const intentFor = (plan: typeof fresh) =>
      plan.steps.find((s) => s.releaseRef === coreRef)!.intent;

    const decide = (intent: 'install' | 'update' | 'repair') =>
      authorizeDelivery({
        subject: 'buyer-1',
        manifest: coreManifest,
        distribution: yankedCore,
        entitlements,
        intent,
        nowMs: 11_000,
      });

    expect(decide(intentFor(fresh)).code).toBe('release-yanked');
    expect(decide(intentFor(upgrade)).deliverable).toBe(true);
  });
});
