/**
 * Harness-op PROXY CoordOps (`harness-provided-cadence-ops-2026-06-26` P-003).
 *
 * Proves: (1) a proxy compiled from a manifest entry dispatches its args to the
 * harness transport and validates the response against `resultSchema`; (2) the
 * registrar is idempotent + default-inert + never shadows a built-in op; (3) a
 * blueprint that DECLARES an op in its `ops:` manifest and references it in its
 * spine validates clean (no `unknown-op`) once the proxy is registered — while a
 * blueprint referencing an UNdeclared op is still rejected; (4) the built-in
 * liveness regression guard (P-001) still passes after a harness proxy is added.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  makeHarnessOpProxy,
  registerHarnessOpProxies,
  isHarnessOpProxy,
  type HarnessOpManifestEntry,
  type HarnessOpDispatchFn,
} from './proxy.js';
import { getCoordOp, registerCoordOp, coordOpNames } from '../coord-ops/registry.js';
import type { CoordOp, CoordOpCtx } from '../coord-ops/types.js';
import { resolveAndValidate } from '../agent-tools/blueprint/_resolve.js';
import { loadBuiltinBlueprint, validateBlueprint } from '@papercusp/orchestrator/blueprint';
import { blueprintRegistrySets } from '../blueprint/registry-sets.js';

function fakeCtx(over: Partial<CoordOpCtx> = {}): CoordOpCtx {
  return {
    identity: { ownerId: 'tester' },
    workspaceId: 'ws-test',
    harnessSlug: 'oddsmith-ops',
    depth: 0,
    now: () => '2026-06-26T00:00:00.000Z',
    newId: (p: string) => `${p}-1`,
    caps: {} as CoordOpCtx['caps'],
    ...over,
  };
}

const PROSPECT_ENTRY: HarnessOpManifestEntry = {
  name: 'oddsmith:prospect-test',
  description: 'one prospector tick (test op)',
  argsSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  resultSchema: {
    type: 'object',
    properties: { enqueued: { type: 'integer' }, keys: { type: 'array', items: { type: 'string' } } },
    required: ['enqueued', 'keys'],
  },
  handler: { kind: 'dispatch' },
};

describe('makeHarnessOpProxy.run dispatches + validates', () => {
  it('dispatches args to the harness slug and returns the validated result', async () => {
    const calls: Array<{ slug: string; op: string; args: unknown; ctx: unknown }> = [];
    const dispatch: HarnessOpDispatchFn = async (slug, op, args, opts) => {
      calls.push({ slug, op, args, ctx: opts.ctx });
      return { enqueued: 2, keys: ['kalshi:A', 'kalshi:B'] };
    };
    const proxy = makeHarnessOpProxy(PROSPECT_ENTRY, dispatch);
    expect(isHarnessOpProxy(proxy)).toBe(true);

    const out = await proxy.run({ limit: 10 }, fakeCtx());
    expect(out).toEqual({ enqueued: 2, keys: ['kalshi:A', 'kalshi:B'] });
    expect(calls).toHaveLength(1);
    expect(calls[0].slug).toBe('oddsmith-ops');
    expect(calls[0].op).toBe('oddsmith:prospect-test');
    expect(calls[0].args).toEqual({ limit: 10 });
    // the serializable ctx slice (no caps) reached the dispatcher
    expect(calls[0].ctx).toMatchObject({ workspaceId: 'ws-test', harnessSlug: 'oddsmith-ops' });
  });

  it('throws when the harness returns a result that violates resultSchema (trust boundary)', async () => {
    const dispatch: HarnessOpDispatchFn = async () => ({ enqueued: 'two' /* not an int */, keys: [] });
    const proxy = makeHarnessOpProxy(PROSPECT_ENTRY, dispatch);
    await expect(proxy.run({ limit: 1 }, fakeCtx())).rejects.toThrow();
  });

  it('requires ctx.harnessSlug to know where to dispatch', async () => {
    const proxy = makeHarnessOpProxy(PROSPECT_ENTRY, async () => ({ enqueued: 0, keys: [] }));
    await expect(proxy.run({}, fakeCtx({ harnessSlug: undefined }))).rejects.toThrow(/harnessSlug/);
  });
});

describe('registerHarnessOpProxies', () => {
  it('is default-inert (empty / undefined ops register nothing)', () => {
    expect(registerHarnessOpProxies([])).toEqual([]);
    expect(registerHarnessOpProxies(undefined)).toEqual([]);
  });

  it('registers a proxy resolvable by name + idempotent re-register', () => {
    const entry: HarnessOpManifestEntry = { name: 'demo:op-idem', resultSchema: {} };
    const names1 = registerHarnessOpProxies([entry]);
    expect(names1).toEqual(['demo:op-idem']);
    expect(isHarnessOpProxy(getCoordOp('demo:op-idem'))).toBe(true);
    // re-register replaces (Map) without error
    const names2 = registerHarnessOpProxies([entry]);
    expect(names2).toEqual(['demo:op-idem']);
  });

  it('NEVER shadows a built-in (non-proxy) op of the same name', () => {
    const builtin: CoordOp = {
      name: 'demo:builtin-guard',
      description: 'a real built-in',
      argsSchema: z.unknown(),
      resultSchema: z.unknown(),
      run: async () => 'builtin',
    };
    registerCoordOp(builtin);
    const registered = registerHarnessOpProxies([{ name: 'demo:builtin-guard', resultSchema: {} }]);
    expect(registered).toEqual([]); // skipped
    expect(isHarnessOpProxy(getCoordOp('demo:builtin-guard'))).toBe(false); // still the built-in
  });
});

describe('a blueprint declaring an op in its ops: manifest validates (no unknown-op)', () => {
  const base = {
    id: 'harness-op-validate-test',
    workItem: { kind: 'decision', idPrefix: 'X' },
    roles: [{ id: 'voter' }],
  };

  it('a spine op declared in ops: resolves once the proxy is registered', () => {
    const r = resolveAndValidate({
      ...base,
      ops: [
        {
          name: 'oddsmith:prospect-bp',
          description: 'prospect tick',
          argsSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
          resultSchema: { type: 'object' },
        },
      ],
      spine: {
        steps: [{ id: 's1', op: 'oddsmith:prospect-bp' }],
        gate: [{ op: 'resolve', else: true }],
      },
    });
    expect(r.ok, JSON.stringify(r.validation?.errors ?? r.parseError)).toBe(true);
    expect(isHarnessOpProxy(getCoordOp('oddsmith:prospect-bp'))).toBe(true);
  });

  it('a spine op that is NOT declared in ops: is still rejected with unknown-op', () => {
    const r = resolveAndValidate({
      ...base,
      spine: {
        steps: [{ id: 's1', op: 'oddsmith:undeclared' }],
        gate: [{ op: 'resolve', else: true }],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.validation?.errors.some((e) => e.code === 'unknown-op')).toBe(true);
  });
});

describe('built-in blueprint liveness regression guard still passes (P-001 unbroken)', () => {
  beforeEach(() => {
    // ensure a harness proxy is present in the registry alongside the built-ins
    registerHarnessOpProxies([{ name: 'demo:coexist', resultSchema: {} }]);
  });
  it('coding-factory still names only registered ops', () => {
    const sets = blueprintRegistrySets();
    expect(coordOpNames().has('demo:coexist')).toBe(true);
    const bp = loadBuiltinBlueprint('coding-factory').blueprint;
    const v = validateBlueprint(bp, sets);
    expect(v.errors.filter((e) => e.code === 'unknown-op')).toEqual([]);
    expect(v.ok).toBe(true);
  });
});
