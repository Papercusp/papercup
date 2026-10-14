import { describe, expect, it, vi } from 'vitest';
import {
  addGovernancePolicyException,
  explainFromLoad,
  getGovernancePolicyState,
  GOVERNANCE_POLICY_SYNC_QUERY,
  MAX_LAYERS_WITH_HISTORY,
  parseGovernedRequest,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
  type GovernancePolicyControlDeps,
} from './control';
import { enforceInheritedPolicy, governedRequestOf } from './enforce';
import { simulateInheritedPolicy, type GovernedRequest, type PolicyLayer } from './inherited-policy';
import { GovernancePolicyWriteError, type ChainLoad, type StoredPolicyLayer, type UpsertLayerInput } from './store';

const NOW = new Date('2026-10-14T00:00:00Z');
const FUTURE = '2026-10-20T00:00:00Z';
const PAST = '2026-10-01T00:00:00Z';

function layer(
  layerId: string,
  level: StoredPolicyLayer['level'],
  parentLayerId: string | null,
  rules: StoredPolicyLayer['rules'],
  extra: Partial<StoredPolicyLayer> = {},
): StoredPolicyLayer {
  return {
    layerId,
    level,
    version: 1,
    rules,
    exceptions: [],
    scopeRef: level === 'workspace' ? 'ws-a' : 'acme',
    parentLayerId,
    contentHash: 'h',
    updatedBy: 'test',
    updatedAt: '2026-10-13T00:00:00Z',
    ...extra,
  };
}

const ORG = layer('org', 'organization', null, { tools: { deny: ['capability:bash'] }, models: { allow: ['claude-*'] } });
const DEPT = layer('dept-eng', 'department', 'org', {});
const WS = layer('ws-a', 'workspace', 'dept-eng', { tools: { allow: ['capability:bash', 'work_items:*'] } });
const OK: ChainLoad = { status: 'ok', chain: [ORG, DEPT, WS] };

function fakeDeps(over: Partial<GovernancePolicyControlDeps> = {}): GovernancePolicyControlDeps & {
  upserts: UpsertLayerInput[];
} {
  const upserts: UpsertLayerInput[] = [];
  const byId = new Map([ORG, DEPT, WS].map((l) => [l.layerId, l]));
  return {
    upserts,
    loadChain: async () => OK,
    listLayers: async () => [...byId.values()],
    listVersions: async () => [],
    loadLayer: async (id) => byId.get(id) ?? null,
    upsertLayer: async (input) => {
      upserts.push(input);
      const prev = byId.get(input.layerId);
      return { ...(prev ?? WS), ...input, exceptions: input.exceptions ?? [], version: (prev?.version ?? 0) + 1 } as StoredPolicyLayer;
    },
    invalidateCache: vi.fn(),
    notify: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  };
}

describe('explainFromLoad — the pane explains exactly what the kernel enforces (P-005)', () => {
  const loads: Array<[string, ChainLoad]> = [
    ['none', { status: 'none' }],
    ['ok', OK],
    ['malformed', { status: 'malformed', reason: 'chain is not organization-rooted', chain: [WS] }],
    [
      'expired exception',
      {
        status: 'ok',
        chain: [{ ...ORG, exceptions: [{ category: 'tools', pattern: 'capability:bash', reason: 'pilot', expiresAt: PAST }] }, DEPT, WS],
      },
    ],
    [
      'active exception',
      {
        status: 'ok',
        chain: [{ ...ORG, exceptions: [{ category: 'tools', pattern: 'capability:bash', reason: 'pilot', expiresAt: FUTURE }] }, DEPT, WS],
      },
    ],
  ];
  const tools = ['capability:bash', 'work_items:list', 'plans:get'];

  for (const [label, load] of loads) {
    for (const toolName of tools) {
      it(`parity with enforceInheritedPolicy: ${label} / ${toolName}`, async () => {
        const kreq = { toolName, capabilities: [], args: {}, boundary: 'dispatch', ctx: { workspaceId: 'ws-a' } };
        const enforced = await enforceInheritedPolicy(kreq as never, { loadChain: async () => load, now: () => NOW });
        const explained = explainFromLoad('ws-a', load, governedRequestOf(kreq as never), NOW);
        expect(explained.verdict.allow).toBe(enforced === null);
        if (!explained.verdict.allow) expect(JSON.stringify(enforced)).toContain(explained.verdict.code.replace('org_policy:', ''));
      });
    }
  }

  it('names the deciding layer: a workspace allow cannot widen the org deny', () => {
    const out = explainFromLoad('ws-a', OK, { tools: ['capability:bash'] }, NOW);
    expect(out.verdict.allow).toBe(false);
    if (out.verdict.allow) return;
    expect(out.verdict.decidedBy?.layerId).toBe('org');
    expect(out.explanation).toContain('organization policy org v1 denies tools');
    expect(out.revision).toBe('org@v1>dept-eng@v1>ws-a@v1');
  });

  it('an unlisted workspace is ungoverned, not refused', () => {
    const out = explainFromLoad('ws-z', { status: 'none' }, { tools: ['capability:bash'] }, NOW);
    expect(out).toMatchObject({ governed: false, verdict: { allow: true }, revision: null });
  });
});

describe('parseGovernedRequest', () => {
  it('keeps governed categories, trims, and drops empty values', () => {
    expect(parseGovernedRequest({ tools: [' capability:bash ', ''], models: [] })).toEqual({
      ok: true,
      request: { tools: ['capability:bash'] },
    });
  });
  it('refuses an unknown category, a non-array and an empty request', () => {
    expect(parseGovernedRequest({ shells: ['bash'] })).toMatchObject({ ok: false });
    expect(parseGovernedRequest({ tools: 'capability:bash' })).toMatchObject({ ok: false });
    expect(parseGovernedRequest({ tools: ['  '] })).toMatchObject({ ok: false });
    expect(parseGovernedRequest(null)).toMatchObject({ ok: false });
  });
});

describe('simulateGovernancePolicy — preview before apply', () => {
  const bash: GovernedRequest = { tools: ['capability:bash'] };
  const list: GovernedRequest = { tools: ['work_items:list'] };

  it('a workspace layer that tries to allow an org-denied tool changes nothing and is flagged decidedByAncestor', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      { layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-eng', rules: { tools: { allow: ['*'] } } },
      [bash, list],
      fakeDeps(),
    );
    expect(sim.validation).toBeNull();
    expect(sim.affectsWorkspace).toBe(true);
    expect(sim.proposedVersion).toBe(2);
    expect(sim.cases[0]).toMatchObject({ changed: false, decidedByAncestor: true, after: { allow: false } });
    expect(sim.cases[1]).toMatchObject({ changed: false, decidedByAncestor: false, after: { allow: true } });
  });

  it('substituting a chain layer matches simulateInheritedPolicy exactly', async () => {
    const proposed = { layerId: 'org', level: 'organization' as const, scopeRef: 'acme', parentLayerId: null, rules: {} };
    const sim = await simulateGovernancePolicy('ws-a', proposed, [bash, list], fakeDeps());
    const ref = simulateInheritedPolicy(OK.status === 'ok' ? OK.chain : [], { ...proposed, version: 2, exceptions: [] } as PolicyLayer, [bash, list], NOW);
    expect(sim.cases.map((c) => [c.before.allow, c.after.allow, c.changed])).toEqual(
      ref.cases.map((c) => [c.before.allow, c.after.allow, c.changed]),
    );
    expect(sim.changedCount).toBe(1);
  });

  it("a first workspace layer for an ungoverned workspace is judged under its parent's ancestry", async () => {
    const sim = await simulateGovernancePolicy(
      'ws-new',
      { layerId: 'ws-new', level: 'workspace', scopeRef: 'ws-new', parentLayerId: 'dept-eng', rules: {} },
      [bash, list],
      fakeDeps({ loadChain: async () => ({ status: 'none' }) }),
    );
    expect(sim.affectsWorkspace).toBe(true);
    expect(sim.proposedRevision).toBe('org@v1>dept-eng@v1>ws-new@v1');
    expect(sim.cases[0]).toMatchObject({ before: { allow: true }, after: { allow: false }, changed: true, decidedByAncestor: true });
  });

  it('a layer outside the chain is reported as not affecting this workspace', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      { layerId: 'dept-sales', level: 'department', scopeRef: 'acme', parentLayerId: 'org', rules: { tools: { deny: ['*'] } } },
      [list],
      fakeDeps(),
    );
    expect(sim.affectsWorkspace).toBe(false);
    expect(sim.note).toContain('not in workspace ws-a');
    expect(sim.changedCount).toBe(0);
  });

  it('reports the validation error set would refuse (an exception without expiry)', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      {
        layerId: 'ws-a',
        level: 'workspace',
        scopeRef: 'ws-a',
        parentLayerId: 'dept-eng',
        rules: {},
        exceptions: [{ category: 'tools', pattern: 'x', reason: 'r' }],
      },
      [list],
      fakeDeps(),
    );
    expect(sim.validation).toMatch(/expiresAt/);
  });
});

describe('setGovernancePolicyLayer — apply with reason, versioned', () => {
  const req = {
    layerId: 'ws-a',
    level: 'workspace' as const,
    scopeRef: 'ws-a',
    parentLayerId: 'dept-eng',
    rules: { tools: { deny: ['plans:*'] } },
    reason: 'lock plans for the pilot',
    expectedVersion: 1,
  };

  it('writes actor + reason + expectedVersion, invalidates every cached chain, notifies the pane', async () => {
    const deps = fakeDeps();
    const out = await setGovernancePolicyLayer(req, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: true, revision: 'ws-a@v2' });
    expect(deps.upserts[0]).toMatchObject({ actor: 'admin:avi', reason: 'lock plans for the pilot', expectedVersion: 1 });
    expect(deps.invalidateCache).toHaveBeenCalledWith();
    expect(deps.notify).toHaveBeenCalledWith(GOVERNANCE_POLICY_SYNC_QUERY);
  });

  it('refuses a blank reason before touching the store', async () => {
    const deps = fakeDeps();
    const out = await setGovernancePolicyLayer({ ...req, reason: '  ' }, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('maps a store conflict to code conflict and does not invalidate', async () => {
    const deps = fakeDeps({
      upsertLayer: async () => {
        throw new GovernancePolicyWriteError('conflict', 'layer ws-a is at v3');
      },
    });
    const out = await setGovernancePolicyLayer(req, 'admin:avi', deps);
    expect(out).toEqual({ ok: false, code: 'conflict', error: 'layer ws-a is at v3' });
    expect(deps.invalidateCache).not.toHaveBeenCalled();
  });

  it('a failed notify does not fail a committed write', async () => {
    const deps = fakeDeps({ notify: async () => Promise.reject(new Error('pg down')) });
    await expect(setGovernancePolicyLayer(req, 'admin:avi', deps)).resolves.toMatchObject({ ok: true });
  });
});

describe('addGovernancePolicyException — expiring exceptions', () => {
  const exception = { category: 'tools' as const, pattern: 'capability:bash', reason: 'incident 42', expiresAt: FUTURE };

  it('appends to the stored layer as a new version, pinned to the version it read', async () => {
    const deps = fakeDeps();
    const out = await addGovernancePolicyException({ layerId: 'org', exception, reason: 'incident 42' }, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: true, revision: 'org@v2' });
    expect(deps.upserts[0]).toMatchObject({ layerId: 'org', expectedVersion: 1, exceptions: [exception], rules: ORG.rules });
  });

  it('refuses a stale expectedVersion and an unknown layer', async () => {
    const deps = fakeDeps();
    await expect(
      addGovernancePolicyException({ layerId: 'org', exception, reason: 'r', expectedVersion: 7 }, 'admin:avi', deps),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    await expect(
      addGovernancePolicyException({ layerId: 'nope', exception, reason: 'r' }, 'admin:avi', deps),
    ).resolves.toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
  });

  it('refuses an exception without a valid absolute expiry (exceptions always expire)', async () => {
    const deps = fakeDeps();
    const out = await addGovernancePolicyException(
      { layerId: 'org', exception: { ...exception, expiresAt: 'next week' }, reason: 'r' },
      'admin:avi',
      deps,
    );
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
  });
});

describe('getGovernancePolicyState', () => {
  it('returns the chain root-first with its revision, and history chain layers first', async () => {
    const listVersions = vi.fn(async () => []);
    const extra = Array.from({ length: MAX_LAYERS_WITH_HISTORY + 2 }, (_, i) => layer(`d${i}`, 'department', 'org', {}));
    const state = await getGovernancePolicyState(
      'ws-a',
      {},
      fakeDeps({ listVersions, listLayers: async () => [...extra, WS, ORG, DEPT] }),
    );
    expect(state.load).toBe('ok');
    expect(state.chain.map((l) => l.layerId)).toEqual(['org', 'dept-eng', 'ws-a']);
    expect(state.revision).toBe('org@v1>dept-eng@v1>ws-a@v1');
    expect(listVersions).toHaveBeenCalledTimes(MAX_LAYERS_WITH_HISTORY);
    expect(Object.keys(state.versions).slice(0, 3)).toEqual(['org', 'dept-eng', 'ws-a']);
    expect(state.historyTruncated).toBe(true);
  });

  it('reports an ungoverned workspace as load none with an empty chain', async () => {
    const state = await getGovernancePolicyState('ws-z', {}, fakeDeps({ loadChain: async () => ({ status: 'none' }) }));
    expect(state).toMatchObject({ load: 'none', chain: [], revision: null, reason: null });
  });
});
