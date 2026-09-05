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
import type { CupboardReleaseManifest } from './listing-manifest';
import {
  planInstall,
  planRollback,
  projectEntitlements,
  type DependencyGraph,
  type InstalledRelease,
} from './entitled-delivery';
import { runInstallPlan, type ApplyInput, type InstallRunnerDeps } from './install-runner';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — real chunked bytes, not stubs.
//
// `contentHash` is set to the package's MERKLE ROOT, not sha256(bytes). That is
// what `validateEncryption`'s public branch (rootHash === release.contentHash)
// and `verifyManifestRoot` (rootHash === merkleRoot(chunks)) jointly require;
// the ordinary flat hash satisfies the first and is refused by the second.
// Filed as EI-22433992128803548 — these fixtures encode the convention so the
// suite exercises the real retrieval path rather than a stubbed one.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 8;
const BYTES = new Map<string, Buffer>([
  ['pack:tools:1.0.0', Buffer.from('tools-payload-abcdefghijklmnop')],
  ['pack:base:1.0.0', Buffer.from('base-payload-qrstuvwxyz')],
]);

function packageFor(ref: string) {
  return buildArtifactPackage(BYTES.get(ref)!, { chunkSizeBytes: CHUNK_SIZE });
}

function manifestFor(ref: string, over: Partial<CupboardReleaseManifest> = {}): CupboardReleaseManifest {
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

function distributionManifest(ref: string, over: Partial<ArtifactDistributionManifest> = {}): ArtifactDistributionManifest {
  const pkg = packageFor(ref);
  return {
    schemaVersion: 1,
    release: manifestFor(ref),
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: 'public',
    encryption: null,
    pinning: DEFAULT_PINNING_POLICY,
    signature: 'dist-sig',
    ...over,
  };
}

function stateFor(ref: string, over: Partial<ArtifactDistributionState> = {}): ArtifactDistributionState {
  return {
    streamId: `dist:${ref}`,
    manifest: distributionManifest(ref),
    sources: [source(), source({ sourceId: 'src-2' })],
    pins: ['src-1'],
    keyVersion: 1,
    revokedKeyVersions: [],
    yankedAtMs: null,
    yankReason: null,
    lastSequence: 1,
    ...over,
  };
}

const TARGET = 'pack:tools:1.0.0';
const DEP = 'pack:base:1.0.0';
const NOW = 10_000;

function entitlements(refs: readonly string[] = [TARGET, DEP]) {
  const events: CommerceEvent[] = refs.map((ref, index) => ({
    eventId: `evt-${index}`,
    streamId: 'commerce-1',
    kind: 'entitlement',
    version: 1,
    issuer: 'seller',
    sequence: index + 1,
    occurredAtMs: 5_000,
    idempotencyKey: `idem-${index}`,
    payload: { entitlementId: `ent-${index}`, subject: 'buyer-1', releaseRef: ref },
    signature: 'sig',
  }));
  return projectEntitlements(events);
}

/** Serves the real chunk bytes. `corrupt` swaps in bytes that will not verify. */
function adapter(options: { readonly corrupt?: boolean; readonly sourceIds?: readonly string[] } = {}): ArtifactProviderAdapter {
  return {
    providerId: 'memory',
    fetchChunk: async ({ source: src, chunk, rootHash }) => {
      if (options.sourceIds && !options.sourceIds.includes(src.sourceId)) {
        throw new Error(`source ${src.sourceId} is unreachable`);
      }
      if (options.corrupt) return Buffer.alloc(chunk.sizeBytes, 0);
      const ref = [...BYTES.keys()].find((key) => packageFor(key).rootHash === rootHash)!;
      const bytes = BYTES.get(ref)!;
      return bytes.subarray(chunk.index * CHUNK_SIZE, chunk.index * CHUNK_SIZE + chunk.sizeBytes);
    },
  };
}

interface Recorder {
  readonly applied: string[];
  readonly reverted: string[];
  readonly fetched: string[];
  readonly deps: InstallRunnerDeps;
}

function recorder(
  over: {
    readonly states?: Partial<Record<string, ArtifactDistributionState | null>>;
    readonly adapter?: ArtifactProviderAdapter;
    readonly applyThrowsFor?: string;
    readonly revertThrowsFor?: string;
  } = {},
): Recorder {
  const applied: string[] = [];
  const reverted: string[] = [];
  const fetched: string[] = [];
  const base = over.adapter ?? adapter();
  const tracking: ArtifactProviderAdapter = {
    providerId: base.providerId,
    fetchChunk: async (request) => {
      fetched.push(`${request.rootHash}#${request.chunk.index}`);
      return base.fetchChunk(request);
    },
  };
  const deps: InstallRunnerDeps = {
    resolveDistribution: (ref) => (ref in (over.states ?? {}) ? over.states![ref]! : stateFor(ref)),
    registry: createProviderRegistry([tracking]),
    apply: (input: ApplyInput): InstalledRelease => {
      if (over.applyThrowsFor === input.releaseRef) throw new Error(`disk full writing ${input.releaseRef}`);
      applied.push(input.releaseRef);
      return { releaseRef: input.releaseRef, installedAtMs: NOW, contentHash: input.release.contentHash };
    },
    revert: ({ releaseRef: ref }) => {
      if (over.revertThrowsFor === ref) throw new Error(`could not remove ${ref}`);
      reverted.push(ref);
    },
  };
  return { applied, reverted, fetched, deps };
}

const GRAPH: DependencyGraph = {
  edges: new Map<string, readonly string[]>([
    [TARGET, [DEP]],
    [DEP, []],
  ]),
};

function plan(installed: ReadonlyMap<string, InstalledRelease> = new Map()) {
  const result = planInstall({ target: TARGET, graph: GRAPH, installed });
  if (!result.ok) throw new Error(`fixture plan failed: ${result.detail}`);
  return result;
}

function run(rec: Recorder, over: Partial<Parameters<typeof runInstallPlan>[1]> = {}) {
  return runInstallPlan(rec.deps, {
    plan: plan(over.installed),
    subject: 'buyer-1',
    entitlements: entitlements(),
    installed: new Map(),
    nowMs: NOW,
    ...over,
  });
}

describe('runInstallPlan — happy path', () => {
  it('fetches and applies every step in dependency order', async () => {
    const rec = recorder();
    const result = await run(rec);

    expect(result.ok).toBe(true);
    // The dependency is applied BEFORE the thing that depends on it.
    expect(rec.applied).toEqual([DEP, TARGET]);
    expect(rec.reverted).toEqual([]);
    if (!result.ok) throw new Error('unreachable');
    expect(result.operation).toBe('install');
    expect(result.installed.map((entry) => entry.releaseRef)).toEqual([DEP, TARGET]);
    expect(result.steps.every((step) => step.status === 'applied')).toBe(true);
  });

  it('records the chunks it actually fetched', async () => {
    const rec = recorder();
    const result = await run(rec);
    if (!result.ok) throw new Error('unreachable');
    const target = result.steps.find((step) => step.releaseRef === TARGET);
    expect(target?.status).toBe('applied');
    if (target?.status !== 'applied') throw new Error('unreachable');
    // Every chunk of the target package, fetched once.
    expect(target.chunksFetched).toBe(packageFor(TARGET).chunks.length);
    expect(target.chunksFetched).toBeGreaterThan(1);
  });

  it('hands apply the verified progress and the signed release manifest', async () => {
    const seen: ApplyInput[] = [];
    const rec = recorder();
    const deps: InstallRunnerDeps = {
      ...rec.deps,
      apply: (input) => {
        seen.push(input);
        return { releaseRef: input.releaseRef, installedAtMs: NOW, contentHash: input.release.contentHash };
      },
    };
    const result = await runInstallPlan(deps, {
      plan: plan(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed: new Map(),
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    const target = seen.find((input) => input.releaseRef === TARGET)!;
    expect(target.release.contentHash).toBe(packageFor(TARGET).rootHash);
    expect(target.progress.held).toEqual(packageFor(TARGET).chunks.map((chunk) => chunk.index));
    expect(target.progress.bytesHeld).toBe(packageFor(TARGET).totalSizeBytes);
  });
});

describe('runInstallPlan — steps that need no work', () => {
  it('skips an already-satisfied step without fetching or applying it', async () => {
    const installed = new Map<string, InstalledRelease>([
      [DEP, { releaseRef: DEP, installedAtMs: 1, contentHash: packageFor(DEP).rootHash }],
    ]);
    const rec = recorder();
    const result = await run(rec, { installed });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const dep = result.steps.find((step) => step.releaseRef === DEP);
    expect(dep?.status).toBe('skipped');
    // The control that makes 'skipped' mean something: no bytes were fetched
    // for it and it was never applied.
    expect(rec.applied).toEqual([TARGET]);
    expect(rec.fetched.some((entry) => entry.startsWith(packageFor(DEP).rootHash))).toBe(false);
  });
});

describe('runInstallPlan — identity binding', () => {
  it('refuses a stream whose manifest describes a DIFFERENT release', async () => {
    // A correctly-formed, correctly-signed manifest — for the wrong release.
    // This is the substitution attack, and it must be caught before any fetch.
    const rec = recorder({ states: { [DEP]: stateFor(DEP, { manifest: distributionManifest(TARGET) }) } });
    const result = await run(rec);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('release-identity-mismatch');
    expect(result.failure.releaseRef).toBe(DEP);
    expect(rec.applied).toEqual([]);
    expect(rec.fetched).toEqual([]);
  });

  it('fails a step whose stream has no manifest, distinctly from one with no stream', async () => {
    const noManifest = recorder({ states: { [DEP]: stateFor(DEP, { manifest: null }) } });
    const missing = recorder({ states: { [DEP]: null } });

    const a = await run(noManifest);
    const b = await run(missing);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) throw new Error('unreachable');
    // Two different faults, two different codes — collapsing them would send a
    // caller looking for a stream that exists.
    expect(a.failure.code).toBe('no-distribution-manifest');
    expect(b.failure.code).toBe('no-distribution-state');
  });
});

describe('runInstallPlan — authorization is per step', () => {
  it('refuses an unentitled subject and applies nothing', async () => {
    const rec = recorder();
    const result = await run(rec, { entitlements: projectEntitlements([]) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('no-entitlement');
    expect(rec.applied).toEqual([]);
    expect(rec.fetched).toEqual([]);
  });

  it('stays fail-closed on a free release until the caller names it', async () => {
    const refused = recorder();
    const allowed = recorder();

    const a = await run(refused, { entitlements: projectEntitlements([]) });
    const b = await run(allowed, {
      entitlements: projectEntitlements([]),
      freeReleaseRefs: new Set([TARGET, DEP]),
    });

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    expect(allowed.applied).toEqual([DEP, TARGET]);
  });

  it('refuses a yanked release for an install but serves it to a rollback in retention', async () => {
    // D-007's two halves, on the SAME yanked release.
    //
    // The reachable `repair` step is planRollback's TARGET, not anything from
    // planInstall: there, every repair step is by construction alreadySatisfied
    // and therefore skipped before delivery is ever considered. Rolling BACK to
    // a version that has since been yanked is the case the intent exists for.
    const yanked = stateFor(DEP, { yankedAtMs: NOW - 1_000, yankReason: 'bad build' });
    const installed = new Map<string, InstalledRelease>([
      [DEP, { releaseRef: DEP, installedAtMs: 1, contentHash: packageFor(DEP).rootHash }],
    ]);

    // Half 1 — a fresh acquisition of a yanked release is refused.
    const fresh = recorder({ states: { [DEP]: yanked } });
    const install = await runInstallPlan(fresh.deps, {
      plan: (() => {
        const built = planInstall({ target: DEP, graph: GRAPH, installed: new Map() });
        if (!built.ok) throw new Error('fixture plan failed');
        return built;
      })(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed: new Map(),
      nowMs: NOW,
    });

    // Half 2 — the same yanked release still serves a rollback to it, because a
    // publisher's yank must not remotely brick an install that already works.
    const rolling = recorder({ states: { [DEP]: yanked } });
    const rollback = await runInstallPlan(rolling.deps, {
      plan: (() => {
        const built = planRollback({ target: DEP, graph: GRAPH, installed });
        if (!built.ok) throw new Error('fixture plan failed');
        return built;
      })(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed,
      nowMs: NOW,
    });

    expect(install.ok).toBe(false);
    if (install.ok) throw new Error('unreachable');
    expect(install.failure.code).toBe('release-yanked');
    expect(fresh.applied).toEqual([]);

    expect(rollback.ok).toBe(true);
    expect(rolling.applied).toEqual([DEP]);
    if (!rollback.ok) throw new Error('unreachable');
    const dep = rollback.steps.find((step) => step.releaseRef === DEP);
    if (dep?.status !== 'applied') throw new Error('unreachable');
    expect(dep.intent).toBe('repair');
    // The caller is TOLD the bytes are withdrawn, even though delivery succeeded.
    expect(dep.servingYankedForExistingInstall).toBe(true);
  });

  it('refuses even a rollback once the yank retention window has closed', async () => {
    // The control for the test above: `repair` is not a permanent exemption
    // from a yank, it is a bounded one. Without this, "serves a rollback" would
    // be indistinguishable from "ignores yanks for rollbacks".
    const retention = DEFAULT_PINNING_POLICY.yankRetentionMs;
    const expired = stateFor(DEP, { yankedAtMs: NOW - retention - 1, yankReason: 'bad build' });
    const installed = new Map<string, InstalledRelease>([
      [DEP, { releaseRef: DEP, installedAtMs: 1, contentHash: packageFor(DEP).rootHash }],
    ]);
    const rec = recorder({ states: { [DEP]: expired } });
    const result = await runInstallPlan(rec.deps, {
      plan: (() => {
        const built = planRollback({ target: DEP, graph: GRAPH, installed });
        if (!built.ok) throw new Error('fixture plan failed');
        return built;
      })(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed,
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('yank-retention-expired');
    expect(rec.applied).toEqual([]);
  });

  it('refuses a rollback whose entitlement was revoked, even inside retention', async () => {
    // Revocation is deliberately asymmetric with a yank: a yank is the
    // publisher withdrawing a version, a revocation is the buyer's right
    // ending, so it is terminal for EVERY intent including repair.
    const yanked = stateFor(DEP, { yankedAtMs: NOW - 1_000, yankReason: 'bad build' });
    const installed = new Map<string, InstalledRelease>([
      [DEP, { releaseRef: DEP, installedAtMs: 1, contentHash: packageFor(DEP).rootHash }],
    ]);
    const revoked = projectEntitlements([
      {
        eventId: 'evt-grant',
        streamId: 'commerce-1',
        kind: 'entitlement',
        version: 1,
        issuer: 'seller',
        sequence: 1,
        occurredAtMs: 5_000,
        idempotencyKey: 'idem-grant',
        payload: { entitlementId: 'ent-0', subject: 'buyer-1', releaseRef: DEP },
        signature: 'sig',
      },
      {
        eventId: 'evt-revoke',
        streamId: 'commerce-1',
        // `refund` and `reversal` are what revoke a grant — there is no
        // 'revocation' kind, and naming one produces an event the projection
        // silently ignores.
        kind: 'refund',
        version: 1,
        issuer: 'seller',
        sequence: 2,
        occurredAtMs: 6_000,
        idempotencyKey: 'idem-revoke',
        payload: { entitlementId: 'ent-0', reason: 'chargeback' },
        signature: 'sig',
      },
    ]);
    const rec = recorder({ states: { [DEP]: yanked } });
    const result = await runInstallPlan(rec.deps, {
      plan: (() => {
        const built = planRollback({ target: DEP, graph: GRAPH, installed });
        if (!built.ok) throw new Error('fixture plan failed');
        return built;
      })(),
      subject: 'buyer-1',
      entitlements: revoked,
      installed,
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('entitlement-revoked');
    expect(rec.applied).toEqual([]);
  });
});

describe('runInstallPlan — rollback', () => {
  it('reverts applied steps in REVERSE order when a later step fails', async () => {
    // The dependency installs; the target's apply then fails.
    const rec = recorder({ applyThrowsFor: TARGET });
    const result = await run(rec);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('apply-failed');
    expect(rec.applied).toEqual([DEP]);
    expect(rec.reverted).toEqual([DEP]);
    expect(result.rollback.complete).toBe(true);
    expect(result.rollback.reverted.map((entry) => entry.releaseRef)).toEqual([DEP]);
  });

  it('reverts a multi-step install newest-first', async () => {
    const graph = GRAPH;
    const rec = recorder({ applyThrowsFor: TARGET });
    const result = await runInstallPlan(rec.deps, {
      plan: (() => {
        const built = planInstall({ target: TARGET, graph, installed: new Map() });
        if (!built.ok) throw new Error('fixture plan failed');
        return built;
      })(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed: new Map(),
      nowMs: NOW,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    const order = result.rollback.reverted.map((entry) => entry.releaseRef);
    expect(order).toEqual([...rec.applied].reverse());
  });

  it('reports a FAILED revert instead of swallowing it', async () => {
    const rec = recorder({ applyThrowsFor: TARGET, revertThrowsFor: DEP });
    const result = await run(rec);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The control: a rollback that could not complete must not read as a clean
    // one, or the caller believes the machine was restored when it was not.
    expect(result.rollback.complete).toBe(false);
    expect(result.rollback.reverted[0]).toMatchObject({ releaseRef: DEP, ok: false });
    expect(result.rollback.reverted[0]!.detail).toContain('could not remove');
  });

  it('rolls back when retrieval fails, not only when apply fails', async () => {
    const rec = recorder({ adapter: adapter({ corrupt: true }) });
    const result = await run(rec);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Corrupt bytes are rejected at the chunk boundary by artifact-package, and
    // every source serves the same bad bytes, so the chunk is unavailable.
    expect(result.failure.code).toBe('chunk-unavailable');
    expect(rec.applied).toEqual([]);
  });
});

describe('runInstallPlan — resumable retrieval', () => {
  it('fetches only the chunks that progress does not already hold', async () => {
    const pkg = packageFor(DEP);
    const rec = recorder();
    const deps: InstallRunnerDeps = {
      ...rec.deps,
      progressFor: (ref) =>
        ref === DEP
          ? {
              rootHash: pkg.rootHash,
              held: [0],
              bytesHeld: pkg.chunks[0]!.sizeBytes,
            }
          : null,
    };
    const result = await runInstallPlan(deps, {
      plan: plan(),
      subject: 'buyer-1',
      entitlements: entitlements(),
      installed: new Map(),
      nowMs: NOW,
    });

    expect(result.ok).toBe(true);
    const depFetches = rec.fetched.filter((entry) => entry.startsWith(pkg.rootHash));
    // Chunk 0 was already held, so it is not refetched — the point of chunking.
    expect(depFetches).toHaveLength(pkg.chunks.length - 1);
    expect(depFetches.some((entry) => entry.endsWith('#0'))).toBe(false);
  });
});

describe('runInstallPlan — source failover', () => {
  it('completes when the first source is unreachable and a later one serves', async () => {
    const rec = recorder({ adapter: adapter({ sourceIds: ['src-2'] }) });
    const result = await run(rec);

    // One dead source degrades throughput; it does not fail the install.
    expect(result.ok).toBe(true);
    expect(rec.applied).toEqual([DEP, TARGET]);
  });
});
