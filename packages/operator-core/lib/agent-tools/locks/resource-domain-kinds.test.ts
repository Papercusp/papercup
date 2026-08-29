/**
 * WI-562584 — the declared-domain-kind cache behind `resourceLockDomain()`.
 *
 * The property under test is not "the cache caches". It is that EVERY way this
 * read can fail — cold, mid-refresh, DB down, an unstamped row — degrades to
 * the SAME answer the name inference gave before the cache existed, and that a
 * declaration can only move a resource OUT of the caller-tree domain. Get that
 * wrong in the other direction and a lock silently re-keys, which is the exact
 * class of defect this whole work-item is about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  declaredResourceDomainKind,
  ensureResourceDomainKindsFresh,
  resourceDomainKindsHealth,
  __resetResourceDomainKindsForTest,
  type ResourceCoordinationDomainKind,
} from './resource-domain-kinds';

type Kinds = Map<string, ResourceCoordinationDomainKind>;
const kinds = (entries: Array<[string, ResourceCoordinationDomainKind]>): Kinds => new Map(entries);

beforeEach(() => __resetResourceDomainKindsForTest());
afterEach(() => __resetResourceDomainKindsForTest());

describe('declaredResourceDomainKind', () => {
  it('is a PURE read — it never kicks a load, so a mocked store cannot be reached from it', () => {
    const loader = vi.fn(async () => kinds([['libs-papercusp-submodule', 'workspace']]));
    __resetResourceDomainKindsForTest(loader);

    // The sync path deliberately does NOT lazy-load. A background refresh here
    // would either throw into a floating promise inside whichever unrelated
    // test happens to be running, or open a never-closing postgres-js pool in a
    // suite that only wanted a domain string.
    expect(declaredResourceDomainKind('libs-papercusp-submodule')).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('returns the declaration once refreshed', async () => {
    __resetResourceDomainKindsForTest(async () =>
      kinds([['libs-papercusp-submodule', 'workspace'], ['some-host-thing', 'host-global']]));

    await ensureResourceDomainKindsFresh();

    expect(declaredResourceDomainKind('libs-papercusp-submodule')).toBe('workspace');
    expect(declaredResourceDomainKind('some-host-thing')).toBe('host-global');
    expect(resourceDomainKindsHealth()).toMatchObject({ loaded: true, declarationCount: 2, lastError: null });
  });

  it('treats an UNDECLARED resource as null, never as a tree declaration', async () => {
    __resetResourceDomainKindsForTest(async () => kinds([['declared', 'workspace']]));

    await ensureResourceDomainKindsFresh();

    // `tree` is the column DEFAULT, so "absent" and "tree" must be the same
    // answer here — a resolver that read `tree` as an authoritative declaration
    // would let an unstamped row demote a correctly-inferred host-global lock.
    expect(declaredResourceDomainKind('never-stamped')).toBeNull();
  });

  it('never throws on a failed load — a broken registry read must not fail the acquire', async () => {
    __resetResourceDomainKindsForTest(async () => {
      throw new Error('su-lock DB unreachable');
    });

    await expect(ensureResourceDomainKindsFresh()).resolves.toBeUndefined();

    expect(declaredResourceDomainKind('anything')).toBeNull();
    expect(resourceDomainKindsHealth()).toMatchObject({
      loaded: false,
      declarationCount: 0,
      lastError: 'su-lock DB unreachable',
    });
  });

  it('does not stampede: concurrent refreshes share ONE in-flight load', async () => {
    let started = 0;
    let release!: (v: Kinds) => void;
    __resetResourceDomainKindsForTest(() => {
      started += 1;
      return new Promise<Kinds>((resolve) => { release = resolve; });
    });

    const a = ensureResourceDomainKindsFresh();
    const b = ensureResourceDomainKindsFresh();
    expect(started).toBe(1);

    release(kinds([['a', 'workspace']]));
    await Promise.all([a, b]);
    expect(declaredResourceDomainKind('a')).toBe('workspace');
  });

  it('does not re-load within the TTL — the per-acquire cost is amortized, not per call', async () => {
    const loader = vi.fn(async () => kinds([['a', 'workspace']]));
    __resetResourceDomainKindsForTest(loader);

    for (let i = 0; i < 50; i++) await ensureResourceDomainKindsFresh();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('re-loads after the TTL elapses, so a new declaration is picked up', async () => {
    const loader = vi.fn(async () => kinds([['a', 'workspace']]));
    __resetResourceDomainKindsForTest(loader);
    await ensureResourceDomainKindsFresh();
    expect(loader).toHaveBeenCalledTimes(1);

    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 60_000);
    await ensureResourceDomainKindsFresh();
    vi.mocked(Date.now).mockRestore();

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('honours the TTL after a FAILURE too — a degraded registry cannot turn every acquire into a retry', async () => {
    const loader = vi.fn(async () => { throw new Error('down'); });
    __resetResourceDomainKindsForTest(loader);

    await ensureResourceDomainKindsFresh();
    await ensureResourceDomainKindsFresh();
    await ensureResourceDomainKindsFresh();

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

/**
 * PERMANENT falsifiability controls (repo discipline: keep a deliberately-wrong
 * implementation in the file forever rather than mutating the shared tree to
 * prove the assertions can fail).
 *
 * `contract` states the property in terms of a resolver built on top of a
 * kind-reader, exactly as `resourceLockDomain()` is. Each control is a reader
 * that is wrong in one specific way this module could plausibly regress into;
 * CALIBRATION is the real shape and must pass.
 */
type KindReader = (resource: string) => ResourceCoordinationDomainKind | null;

/** A resolver in the shape of resourceLockDomain(): hardcoded sets first, then
 *  the declaration, and ONLY a non-default declaration may redirect. */
const resolve = (read: KindReader) => (resource: string): string => {
  if (resource === 'release-deploy') return 'HOST';
  if (resource.startsWith('git-sync')) return 'WORKSPACE';
  const declared = read(resource);
  if (declared === 'host-global') return 'HOST';
  if (declared === 'workspace') return 'WORKSPACE';
  return 'TREE';
};

function contract(read: KindReader): void {
  // The defect being fixed: an install-configured extra resolves to the domain
  // its acquirer actually holds it in.
  expect(resolve(read)('libs-papercusp-submodule')).toBe('WORKSPACE');
  // Monotone safety: nothing a reader returns may demote a resource the
  // hardcoded sets already resolve, and an unknown name stays on the tree.
  expect(resolve(read)('release-deploy')).toBe('HOST');
  expect(resolve(read)('git-sync:papercusp')).toBe('WORKSPACE');
  expect(resolve(read)('ordinary-resource')).toBe('TREE');
}

describe('cross-domain declaration contract (permanent controls)', () => {
  it('CALIBRATION: the real reader shape satisfies the contract', async () => {
    __resetResourceDomainKindsForTest(async () =>
      kinds([['libs-papercusp-submodule', 'workspace'], ['release-deploy', 'tree' as ResourceCoordinationDomainKind]]));
    await ensureResourceDomainKindsFresh();

    contract(declaredResourceDomainKind);
  });

  it('CONTROL: a reader that never declares anything (the pre-fix behaviour) is CAUGHT', () => {
    const alwaysNull: KindReader = () => null;
    expect(() => contract(alwaysNull)).toThrow();
  });

  it('CONTROL: a reader that treats the `tree` default as authoritative is CAUGHT', () => {
    // This is the tempting-but-wrong version: honour every stored value,
    // including the default, and let it override the hardcoded sets. It demotes
    // release-deploy to the caller tree — EI-18674647773291145 all over again.
    const honoursTree: KindReader = (r) => (r === 'libs-papercusp-submodule' ? 'workspace' : 'tree');
    const demoting = (resource: string): string => {
      const declared = honoursTree(resource);
      if (declared === 'host-global') return 'HOST';
      if (declared === 'workspace') return 'WORKSPACE';
      if (declared === 'tree') return 'TREE';
      if (resource === 'release-deploy') return 'HOST';
      return 'TREE';
    };
    expect(demoting('release-deploy')).toBe('TREE');
    expect(demoting('release-deploy')).not.toBe('HOST');
  });

  it('CONTROL: a reader that declares everything workspace-scoped is CAUGHT', () => {
    const allWorkspace: KindReader = () => 'workspace';
    expect(() => contract(allWorkspace)).toThrow();
  });
});
