/**
 * list.test.ts — locks:list HANDLER domain-resolution behavior
 * (EI-18674647773291145 Defect 2). `readResourceQueue` / `getResource` /
 * `listResources` are mocked; this catches a regression where the tool
 * silently reports `holders: []` for a host-global resource (e.g.
 * 'release-deploy') because it only ever queried the caller's own
 * tree-scoped coordination domain instead of following the resource into
 * the fixed `hostGlobalLockDomain()` it actually acquires under — the exact
 * failure observed live (`locks:list { resource: 'release-deploy' }`
 * returning `holders: []` for a lock provably held elsewhere).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: '/caller/tree' })),
}));
vi.mock('./coordination-domain', () => ({
  hostGlobalLockDomain: vi.fn(() => 'papercusp-host-global'),
  HOST_GLOBAL_RESOURCES: new Set(['release-deploy']),
  // WI-5960: a `git-sync:<slug>` (or any workspace-scoped) resource's system-side
  // acquirer keys itself by workspace, not by the caller's tree — a distinct
  // domain from BOTH the caller domain and hostGlobalLockDomain so the merge/
  // routing tests below can tell the three apart.
  isWorkspaceScopedResource: vi.fn((r: string) => r.startsWith('git-sync:')),
  workspaceScopedLockDomain: vi.fn(() => 'ws-scoped-domain'),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(() => ({})),
  getResource: vi.fn(),
  listResources: vi.fn(),
  readResourceQueue: vi.fn(),
}));

import { getResource, listResources, readResourceQueue } from './su-lock-store';
const getResourceM = vi.mocked(getResource);
const listResourcesM = vi.mocked(listResources);
const queueM = vi.mocked(readResourceQueue);

const tool = (await import('./list')).default;
type Out = {
  data: {
    ok: boolean;
    // EI-22073686775053989: `resources[]` rows are DENORMALIZED with their own
    // `holders` + `held`. This local mirror of the handler's `{data}` envelope
    // must carry it — omitting it is not a lax annotation but a false one: the
    // describe block below reads `b.data.resources`, so a missing key here is a
    // TS2339 that reads as "the tool does not return resources" when the tool
    // very much does (list.ts builds `resourcesWithHolders`).
    resources: Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: string;
      holders: unknown[];
      held: boolean;
    }>;
    holders: unknown[];
    draining: boolean;
    plane: string;
    fileLockHint: string;
  };
};
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;

const holder = (owner: string, resource = 'dev-server') => ({
  resource,
  owner,
  owner_label: owner,
  mode: 'exclusive' as const,
  status: 'held' as const,
  reason: '',
  lock_id: owner,
  acquired_ts: new Date('2026-01-01T00:00:00Z'),
  expires_ts: new Date('2026-01-01T00:20:00Z'),
  fence_seq: 1,
});

beforeEach(() => vi.clearAllMocks());

/** Resolve the queue mock per-domain: holders only from `heldBy`. Module-scoped
 * so both describe blocks below can share it. */
const heldOnlyIn = (heldBy: string, rows: ReturnType<typeof holder>[], draining = false) =>
  mockImplementationTyped(queueM, async (_pool, params) =>
    params.coordinationDomain === heldBy ? { holders: rows, draining } : { holders: [], draining: false },
  );

describe('locks:list — host-global domain resolution (EI-18674647773291145)', () => {
  it('makes the workspace-global scope and resource-only filter explicit', () => {
    expect(tool.name).toBe('locks:list');
    expect(tool.capability).toBe('locks:read');
    expect(tool.description).toContain('workspace-global lock diagnostic: omit workspace/harness');
    expect(tool.guidance?.chaining).toContain('omit workspace/harness');
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ resource: 'dev-server' }).success).toBe(true);
    expect(tool.args.safeParse({ workspace: 'papercusp-workspace' }).success).toBe(false);
  });

  // EI-21733256625452096: these three assert a SCOPED query reaches the domain
  // the resource is really acquired under. They used to also assert it queried
  // ONLY that one domain (`toHaveBeenCalledTimes(1)`), inferring the domain from
  // the resource NAME. That exclusivity was the defect: a name that matches
  // neither HOST_GLOBAL_RESOURCES nor isWorkspaceScopedResource() resolved to the
  // caller's tree and reported a false `holders: []` for a lock held elsewhere.
  // The contract is now "query every candidate domain and merge", so each test
  // supplies the holder from ONLY the domain that genuinely holds it — which
  // proves the merge attributes it correctly rather than just counting calls.
  const ALL_DOMAINS = ['/caller/tree', 'papercusp-host-global', 'ws-scoped-domain'];

  const domainsQueried = () =>
    queueM.mock.calls.map((c) => (c[1] as { coordinationDomain: string }).coordinationDomain);

  it('scoped to a host-global resource: reaches hostGlobalLockDomain', async () => {
    getResourceM.mockResolvedValue({ resource: 'release-deploy', description: '', rule_text: '', enforcement: 'enforced' } as never);
    heldOnlyIn('papercusp-host-global', [holder('release-deploy:123:uuid', 'release-deploy')]);

    const b = await call({ resource: 'release-deploy' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: 'papercusp-host-global',
      resource: 'release-deploy',
    });
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: 'papercusp-host-global' });
  });

  it('scoped to an ordinary resource: reaches the caller domain', async () => {
    getResourceM.mockResolvedValue({ resource: 'dev-server', description: '', rule_text: '', enforcement: 'enforced' } as never);
    heldOnlyIn('/caller/tree', [holder('some-agent')]);

    const b = await call({ resource: 'dev-server' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: '/caller/tree',
      resource: 'dev-server',
    });
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: '/caller/tree' });
  });

  // WI-5960: the exact live incident — an agent held `exclusive(git-sync:papercusp)`
  // (correctly landing in workspaceScopedLockDomain()) and `locks:list` reported
  // it as unheld because it only ever queried the caller's tree-scoped domain.
  it('scoped to a workspace-scoped resource (git-sync:<slug>): reaches workspaceScopedLockDomain', async () => {
    getResourceM.mockResolvedValue({ resource: 'git-sync:papercusp', description: '', rule_text: '', enforcement: 'advisory' } as never);
    heldOnlyIn('ws-scoped-domain', [holder('system:git-sync', 'git-sync:papercusp')]);

    const b = await call({ resource: 'git-sync:papercusp' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: 'ws-scoped-domain' });
  });

  // EI-21733256625452096 — THE REGRESSION GUARD. `libs-papercusp-submodule` is a
  // human-registered `trigger_config.extra_lock_resources` name. git-sync acquires
  // every lock in its set, extras included, under one `cd = workspaceId || '*'`
  // (git-sync-action.ts `handleGitSync`), but the name matches neither
  // HOST_GLOBAL_RESOURCES nor isWorkspaceScopedResource() — so the old
  // name-inferring branch looked in the caller's tree and returned `holders: []`
  // for a lock that was held, exclusive and unexpired, in the workspace domain
  // (falsified against agent_resource_locks 21:20:11Z, reproduced 8 min apart).
  // A false `holders: []` is not a missing answer, it reads as permission to
  // proceed on a resource a peer holds, and enforcement here is `advisory`.
  it('scoped to a name that advertises NO domain but is held in the workspace domain: still reports the holder', async () => {
    mockResolvedTyped(getResourceM, {
      resource: 'libs-papercusp-submodule',
      description: '',
      rule_text: '',
      enforcement: 'advisory',
      match_patterns: [],
      max_holders: null,
    });
    heldOnlyIn('ws-scoped-domain', [holder('system:git-sync:1856221:ff20faa8', 'libs-papercusp-submodule')]);

    const b = await call({ resource: 'libs-papercusp-submodule' });

    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({
      resource: 'libs-papercusp-submodule',
      owner: 'system:git-sync:1856221:ff20faa8',
      coordination_domain: 'ws-scoped-domain',
    });
  });

  it('unscoped listing merges the caller domain, host-global domain, AND workspace-scoped domain, OR-ing draining', async () => {
    listResourcesM.mockResolvedValue([]);
    queueM
      .mockResolvedValueOnce({ holders: [holder('caller-owner')], draining: false })
      .mockResolvedValueOnce({ holders: [holder('release-deploy:999:uuid', 'release-deploy')], draining: true })
      .mockResolvedValueOnce({ holders: [holder('system:git-sync', 'git-sync:papercusp')], draining: false });

    const b = await call({});

    expect(queueM).toHaveBeenCalledTimes(3);
    expect(queueM).toHaveBeenNthCalledWith(1, expect.anything(), { coordinationDomain: '/caller/tree', resource: undefined });
    expect(queueM).toHaveBeenNthCalledWith(2, expect.anything(), { coordinationDomain: 'papercusp-host-global', resource: undefined });
    expect(queueM).toHaveBeenNthCalledWith(3, expect.anything(), { coordinationDomain: 'ws-scoped-domain', resource: undefined });
    expect(b.data.holders).toHaveLength(3);
    expect(b.data.draining).toBe(true);
    expect(b.data.holders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'caller-owner', resource: 'dev-server' }),
        expect.objectContaining({ owner: 'release-deploy:999:uuid', resource: 'release-deploy' }),
        expect.objectContaining({ owner: 'system:git-sync', resource: 'git-sync:papercusp' }),
      ]),
    );
  });

  it('marks the resource plane and routes file-holder checks to locks:queue', async () => {
    listResourcesM.mockResolvedValue([]);
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({});

    expect(b.data.plane).toBe('resource');
    expect(b.data.fileLockHint).toContain('locks:queue { paths: [...] }');
    expect(b.data.fileLockHint).not.toContain('locks:list { paths');
  });
});

// EI-22073686775053989: `resources[]` used to carry no `owner`/`holders` field
// at all — `holders` was ONLY a top-level sibling array — so both natural-
// looking reads (`r.owner`, `r.holders ?? []`) silently produced a confident,
// well-formed "free" for a resource that was actually held. These assert the
// fix: each resources[] row is denormalized with its OWN `holders` array
// (in sync with the flat top-level one) and a `held` boolean.
describe('locks:list — resources[] denormalized with holders (EI-22073686775053989)', () => {
  const registryRow = (resource: string) =>
    ({ resource, description: '', rule_text: 'rule text', enforcement: 'enforced' as const });

  it('a HELD registered resource carries its holder nested under resources[].holders, and held:true', async () => {
    listResourcesM.mockResolvedValue([registryRow('git-sync:portal') as never]);
    mockImplementationTyped(queueM, async (_pool, params) =>
      params.coordinationDomain === '/caller/tree'
        ? { holders: [holder('su-202a8f71', 'git-sync:portal')], draining: false }
        : { holders: [], draining: false },
    );

    const b = await call({});

    const [resourceRow] = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    expect(resourceRow.resource).toBe('git-sync:portal');
    expect(resourceRow.held).toBe(true);
    expect(resourceRow.holders).toHaveLength(1);
    expect(resourceRow.holders[0]).toMatchObject({ resource: 'git-sync:portal', owner: 'su-202a8f71' });
    // The nested view and the flat top-level view must never disagree.
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ resource: 'git-sync:portal', owner: 'su-202a8f71' });
  });

  it('a FREE registered resource reports a MEASURED empty: holders:[] and held:false (never a missing key)', async () => {
    listResourcesM.mockResolvedValue([registryRow('dev-server') as never]);
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({});

    const [resourceRow] = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    expect(resourceRow.resource).toBe('dev-server');
    expect(resourceRow.held).toBe(false);
    expect(resourceRow.holders).toEqual([]);
  });

  it('two registered resources, one held one free: each gets ONLY its own holders, not the other’s', async () => {
    listResourcesM.mockResolvedValue([registryRow('dev-server') as never, registryRow('release-deploy') as never]);
    heldOnlyIn('papercusp-host-global', [holder('release-deploy:1:uuid', 'release-deploy')]);

    const b = await call({});

    const rows = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    const devServer = rows.find((r) => r.resource === 'dev-server')!;
    const releaseDeploy = rows.find((r) => r.resource === 'release-deploy')!;
    expect(devServer.held).toBe(false);
    expect(devServer.holders).toEqual([]);
    expect(releaseDeploy.held).toBe(true);
    expect(releaseDeploy.holders).toHaveLength(1);
  });
});
