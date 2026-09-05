/**
 * Door-level tests for the install gate (D-045 §3a, WI-2146325).
 *
 * These assert the REFUSALS a door owes, not the internals of the layers it
 * composes: an unentitled install, a tampered package, a yanked version, and a
 * paid listing with no chain to check are each refused AT THE DOOR, before any
 * `*-io` core is reached. The update/rollback round-trip is here for the same
 * reason — it is the behaviour a door promises, and it was unreachable in
 * production until this gate existed.
 *
 * Fixtures follow `install-runner.test.ts`: real chunked bytes, and
 * `contentHash` set to the package's MERKLE ROOT rather than sha256(bytes),
 * which is what `verifyManifestRoot` and the public encryption branch jointly
 * require (EI-22433992128803548).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PINNING_POLICY,
  type ArtifactDistributionManifest,
  type ArtifactDistributionState,
  type DistributionSource,
} from '../p2p/artifact-distribution';
import {
  buildArtifactPackage,
  createProviderRegistry,
  type ArtifactProviderAdapter,
} from '../p2p/artifact-package';
import type { CommerceEvent } from '../p2p/commerce-events';
import { memoryArtifactStore } from './artifact-store';
import {
  projectEntitlements,
  type DependencyGraph,
  type InstalledRelease,
} from './entitled-delivery';
import {
  gateCupboardInstall,
  listingIsPaid,
  type DoorListingFacts,
  type DoorReleaseChain,
  type InstallDoorGateDeps,
} from './install-door-gate';
import type { ApplyInput, InstallRunnerDeps } from './install-runner';
import type { CupboardReleaseManifest } from './listing-manifest';

const CHUNK_SIZE = 8;
const TARGET = 'pack:tools:1.0.0';
const PRIOR = 'pack:tools:0.9.0';
const NOW = 10_000;

const BYTES = new Map<string, Buffer>([
  [TARGET, Buffer.from('tools-payload-abcdefghijklmnop')],
  [PRIOR, Buffer.from('tools-payload-0-9-0-aaaaaaaaaa')],
]);

const packageFor = (ref: string) => buildArtifactPackage(BYTES.get(ref)!, { chunkSizeBytes: CHUNK_SIZE });

function manifestFor(ref: string): CupboardReleaseManifest {
  const [listingKind, listingRef, releaseVersion] = ref.split(':') as [
    CupboardReleaseManifest['listingKind'],
    string,
    string,
  ];
  return {
    schemaVersion: 1,
    listingKind,
    listingRef,
    releaseVersion,
    contentHash: packageFor(ref).rootHash,
    signature: 'sig',
    dependencies: [],
    compatibility: { runtime: 'node>=22' },
    permissions: [],
    capabilities: [],
    license: 'MIT',
    publisher: { githubUserId: 42, login: 'alice' },
    reviewStatus: 'approved',
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

function distributionManifest(ref: string, encrypted = false): ArtifactDistributionManifest {
  const pkg = packageFor(ref);
  return {
    schemaVersion: 1,
    release: manifestFor(ref),
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: encrypted ? 'private' : 'public',
    encryption: encrypted
      ? { scheme: 'aes-256-gcm', keyVersion: 1, ciphertextHash: pkg.rootHash, wrappedKeyIds: ['wk-1'] }
      : null,
    pinning: DEFAULT_PINNING_POLICY,
    signature: 'dist-sig',
  };
}

function stateFor(
  ref: string,
  over: Partial<ArtifactDistributionState> = {},
  encrypted = false,
): ArtifactDistributionState {
  return {
    streamId: `dist:${ref}`,
    manifest: distributionManifest(ref, encrypted),
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

function entitlementsFor(refs: readonly string[]) {
  const events: CommerceEvent[] = refs.map((ref, index) => ({
    eventId: `evt-${index}`,
    streamId: 'commerce-1',
    kind: 'entitlement',
    version: 1,
    issuer: 'seller',
    sequence: index + 1,
    occurredAtMs: 5_000,
    idempotencyKey: `idem-${index}`,
    payload: { entitlementId: `ent-${index}`, subject: 'buyer-1', releaseRef: ref, keyVersion: 1 },
    signature: 'sig',
  }));
  return projectEntitlements(events);
}

function adapter(): ArtifactProviderAdapter {
  return {
    providerId: 'memory',
    fetchChunk: async ({ chunk, rootHash }) => {
      const ref = [...BYTES.keys()].find((key) => packageFor(key).rootHash === rootHash)!;
      const bytes = BYTES.get(ref)!;
      return bytes.subarray(chunk.index * CHUNK_SIZE, chunk.index * CHUNK_SIZE + chunk.sizeBytes);
    },
  };
}

const GRAPH: DependencyGraph = {
  edges: new Map<string, readonly string[]>([
    [TARGET, []],
    [PRIOR, []],
  ]),
};

const FREE_LISTING: DoorListingFacts = {
  listingKind: 'pack',
  listingRef: 'tools',
  priceModel: 'free',
  releaseVersion: '1.0.0',
};
const PAID_LISTING: DoorListingFacts = {
  listingKind: 'pack',
  listingRef: 'tools',
  priceModel: 'one-time',
  priceAmountMicros: 9_000_000,
  releaseVersion: '1.0.0',
};

interface ChainOptions {
  readonly entitled?: readonly string[];
  readonly installed?: readonly InstalledRelease[];
  readonly yanked?: boolean;
  /** Ask for a release the manifest does not describe — a substitution attempt. */
  readonly tampered?: boolean;
  readonly target?: string;
}

function chainFor(options: ChainOptions = {}): DoorReleaseChain {
  const target = options.target ?? TARGET;
  return {
    releaseRef: target,
    graph: GRAPH,
    installed: new Map((options.installed ?? []).map((entry) => [entry.releaseRef, entry])),
    entitlements: entitlementsFor(options.entitled ?? [TARGET, PRIOR]),
    signedPackage: {
      manifest: manifestFor(target),
      expected: options.tampered
        ? { listingKind: 'pack', listingRef: 'tools', releaseVersion: '9.9.9' }
        : {
            listingKind: 'pack',
            listingRef: 'tools',
            releaseVersion: target.split(':')[2] as string,
          },
    },
  };
}

interface Harness {
  readonly deps: InstallDoorGateDeps;
  readonly applied: string[];
  readonly reverted: string[];
}

function harness(
  chain: DoorReleaseChain | null,
  options: { readonly yanked?: boolean; readonly encrypted?: boolean } = {},
): Harness {
  const applied: string[] = [];
  const reverted: string[] = [];
  const store = memoryArtifactStore();
  for (const ref of BYTES.keys()) {
    const pkg = packageFor(ref);
    store.put({
      contentHash: pkg.rootHash,
      sizeBytes: pkg.totalSizeBytes,
      contentType: 'application/octet-stream',
    });
  }

  const runner: InstallRunnerDeps = {
    resolveDistribution: (ref) =>
      BYTES.has(ref)
        ? stateFor(
            ref,
            options.yanked ? { yankedAtMs: 6_000, yankReason: 'withdrawn' } : {},
            options.encrypted === true,
          )
        : null,
    registry: createProviderRegistry([adapter()]),
    apply: (input: ApplyInput): InstalledRelease => {
      applied.push(input.releaseRef);
      return {
        releaseRef: input.releaseRef,
        installedAtMs: NOW,
        contentHash: input.distribution.rootHash,
      };
    },
    revert: ({ releaseRef: ref }) => {
      reverted.push(ref);
    },
  };

  return {
    applied,
    reverted,
    deps: {
      loadReleaseChain: () => chain,
      runner,
      // Signature verification is the door's own check; the identity binding it
      // guards is exercised by the `tampered` chain, which supplies a manifest
      // for a release the caller did not ask for.
      verify: { store, verifySignature: () => true },
      nowMs: () => NOW,
    },
  };
}

describe('listingIsPaid', () => {
  it('needs BOTH a non-free model and a positive amount', () => {
    expect(listingIsPaid(PAID_LISTING)).toBe(true);
    expect(listingIsPaid(FREE_LISTING)).toBe(false);
    expect(listingIsPaid({ listingKind: 'pack', listingRef: 'tools' })).toBe(false);
    // An unfinished storefront row — a model with no amount charges nobody, so
    // treating it as paid would refuse installs no one pays for.
    expect(listingIsPaid({ listingKind: 'pack', listingRef: 'tools', priceModel: 'one-time' })).toBe(
      false,
    );
    expect(
      listingIsPaid({
        listingKind: 'pack',
        listingRef: 'tools',
        priceModel: 'one-time',
        priceAmountMicros: 0,
      }),
    ).toBe(false);
  });
});

describe('gateCupboardInstall — no release chain', () => {
  it('refuses a PAID listing that publishes no chain', async () => {
    const { deps, applied } = harness(null);
    const decision = await gateCupboardInstall(deps, { listing: PAID_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('paid-listing-without-release-chain');
    expect(applied).toEqual([]);
  });

  it('lets a FREE listing through unmanaged, and says why', async () => {
    const { deps } = harness(null);
    const decision = await gateCupboardInstall(deps, { listing: FREE_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(true);
    expect(decision.ok === true && decision.mode).toBe('unmanaged');
    expect(decision.ok === true && decision.mode === 'unmanaged' && decision.detail).toContain(
      'no release chain',
    );
  });
});

describe('gateCupboardInstall — managed path', () => {
  it('refuses an UNENTITLED install of a paid release', async () => {
    const { deps, applied } = harness(chainFor({ entitled: [] }));
    const decision = await gateCupboardInstall(deps, { listing: PAID_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('not-entitled');
    expect(applied).toEqual([]);
  });

  it('refuses a TAMPERED package before any plan is built', async () => {
    const { deps, applied } = harness(chainFor({ tampered: true }));
    const decision = await gateCupboardInstall(deps, { listing: PAID_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('package-unverified');
    expect(decision.ok === false && decision.detail).toContain('release-identity-mismatch');
    expect(applied).toEqual([]);
  });

  it('refuses a YANKED release to a new installer', async () => {
    const { deps, applied } = harness(chainFor(), { yanked: true });
    const decision = await gateCupboardInstall(deps, { listing: PAID_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('release-yanked');
    expect(applied).toEqual([]);
  });

  it('installs an entitled release, then updates over the prior version', async () => {
    const first = harness(chainFor());
    const installed = await gateCupboardInstall(first.deps, {
      listing: PAID_LISTING,
      subject: 'buyer-1',
    });
    expect(installed.ok).toBe(true);
    expect(installed.ok === true && installed.mode === 'managed' && installed.run.operation).toBe(
      'install',
    );
    expect(first.applied).toEqual([TARGET]);

    const prior: InstalledRelease = { releaseRef: PRIOR, installedAtMs: 1, contentHash: 'old' };
    const second = harness(chainFor({ installed: [prior] }));
    const updated = await gateCupboardInstall(second.deps, {
      listing: PAID_LISTING,
      subject: 'buyer-1',
    });
    expect(updated.ok === true && updated.mode === 'managed' && updated.run.operation).toBe('update');
    expect(second.applied).toEqual([TARGET]);
  });

  it('rolls back to a version this subject already had', async () => {
    const prior: InstalledRelease = { releaseRef: PRIOR, installedAtMs: 1, contentHash: 'old' };
    const { deps, applied } = harness(chainFor({ installed: [prior], target: PRIOR }));
    const decision = await gateCupboardInstall(deps, {
      listing: PAID_LISTING,
      subject: 'buyer-1',
      operation: 'rollback',
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok === true && decision.mode === 'managed' && decision.run.operation).toBe(
      'rollback',
    );
    expect(applied).toEqual([PRIOR]);
  });

  it('refuses an ENCRYPTED release when no decryption seam is configured', async () => {
    // Without this refusal the ordinary apply writes CIPHERTEXT into place and
    // reports success — a corrupted install that looks like a working one
    // (D-044 §2c: openRetrievedArtifact owes the decryption).
    const { deps, applied } = harness(chainFor(), { encrypted: true });
    const decision = await gateCupboardInstall(deps, { listing: PAID_LISTING, subject: 'buyer-1' });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('install-failed');
    expect(decision.ok === false && decision.detail).toContain('openRetrievedArtifact');
    expect(applied).toEqual([]);
  });

  it('applies an ENCRYPTED release through the decryption seam when one IS configured', async () => {
    const opened: string[] = [];
    const base = harness(chainFor(), { encrypted: true });
    const decision = await gateCupboardInstall(
      {
        ...base.deps,
        openArtifact: (input) => {
          opened.push(input.releaseRef);
          return { releaseRef: input.releaseRef, installedAtMs: NOW, contentHash: 'plaintext' };
        },
      },
      { listing: PAID_LISTING, subject: 'buyer-1' },
    );
    expect(decision.ok).toBe(true);
    expect(opened).toEqual([TARGET]);
    // The ordinary apply must NOT also run — that would write the ciphertext.
    expect(base.applied).toEqual([]);
  });

  it('refuses a rollback to a version that was never installed here', async () => {
    const { deps, applied } = harness(chainFor({ target: PRIOR }));
    const decision = await gateCupboardInstall(deps, {
      listing: PAID_LISTING,
      subject: 'buyer-1',
      operation: 'rollback',
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe('plan-failed');
    expect(decision.ok === false && decision.detail).toContain('rollback-target-not-installed');
    expect(applied).toEqual([]);
  });
});
