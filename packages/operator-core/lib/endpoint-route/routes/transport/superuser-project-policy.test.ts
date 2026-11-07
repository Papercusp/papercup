import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolve: vi.fn(async (workspace: string, slug: string): Promise<string | null> =>
    slug === 'C' ? 'foreign' : slug === 'unknown' ? null : workspace),
  policy: null as null | { mode: 'enforce'; allowHarnesses: string[] },
}));
vi.mock('../../../harness-core', () => ({ resolveWorkspaceForHarnessSlugIn: h.resolve }));
vi.mock('../../../pot-control-policy', () => ({
  placementOverride: () => ({ workScope: h.policy }),
  readPotControlPolicy: vi.fn(), refreshPotControlPolicy: vi.fn(), writePotControlPolicy: vi.fn(),
}));
vi.mock('@papercusp/flags/server', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), getFlag: vi.fn(async () => true),
}));

import { applySuperuserProjectPolicy } from './superuser-project-policy';
import { bindCurrentCallerDispatch } from '../../../agent-tools/orchestration/current-caller-dispatch';

const caller = { workspaceId: 'workspace', harnessSlug: 'A', role: 'operator', profile: 'engineer', isSuperuser: true };

// Independent, explicit registered-schema fixtures; never derive these from the collector.
const fixtures: Array<[string, (target: unknown) => Record<string, unknown>]> = [
  ['work_items:get', target => ({ harness: target })],
  ['plans:get', target => ({ harness: target, slug: 'plan' })],
  ['memory:search', target => ({ harness_slug: target, query: 'text' })],
  ['memory:list', target => ({ hive_slug: target })],
  ['roles:list', target => ({ harnessSlug: target })],
  ['pot:get', target => ({ slug: target })],
  ['harness:get', target => ({ slug: target })],
  ['work_items:claim', target => ({ harness: 'A', items: [{ id: 'WI-one', harness: target }] })],
  ['work_items:checkpoint', target => ({ items: [{ id: 'WI-one', harness: target }] })],
  ['facts:list', target => ({ scope: 'harness', scopeRef: target })],
  ['facts:list', target => ({ scope: 'harness', scope_ref: target })],
  ['facts:list', target => ({ scope: 'harness', ref: target })],
  ['facts:list', target => ({ scope: 'harness', harness: target })],
  ['capability:launch-agent', target => ({ harness: target })],
  ['fleet:launch-on-plan', target => ({ harness: 'A', hive: target })],
];

beforeEach(() => {
  h.resolve.mockReset();
  h.resolve.mockImplementation(async (workspace, slug) => slug === 'C' ? 'foreign' : slug === 'unknown' ? null : workspace);
  h.policy = null;
});

describe.each(['direct policy', 'nested orchestration'])('%s project authorization', route => {
  async function dispatch(name: string, args: Record<string, unknown>) {
    const handler = vi.fn(async (ctx: typeof caller, input: unknown) => ({ ctx, input }));
    let result: unknown;
    if (route === 'direct policy') {
      const decision = await applySuperuserProjectPolicy(name, caller, args, true);
      result = decision?.ok
        ? await handler({ ...caller, harnessSlug: decision.effectiveHarnessSlug! }, decision.args)
        : decision && !decision.ok ? decision.result : undefined;
    } else {
      result = await bindCurrentCallerDispatch({ needsWorkspaceTx: true } as never, name, args,
        { ...caller, tx: { outer: true } } as never, handler as never);
    }
    return { handler, result };
  }

  it.each(fixtures)('%s admits selected A and sibling B, refuses foreign/unresolved/wildcard/malformed targets', async (name, args) => {
    for (const target of ['A', 'B']) {
      const { handler } = await dispatch(name, args(target));
      expect(handler, `${name} ${target}`).toHaveBeenCalledTimes(1);
    }
    for (const target of ['C', 'unknown', '*', 'all', null, 42, '', ' ']) {
      const { handler, result } = await dispatch(name, args(target));
      expect(handler, `${name} ${String(target)}`).not.toHaveBeenCalled();
      expect(result).toMatchObject({ isError: true });
    }
  });

  it.each(fixtures)('%s refuses registry failure before its handler', async (name, args) => {
    h.resolve.mockRejectedValue(new Error('registry unavailable or ambiguous'));
    const { handler, result } = await dispatch(name, args('B'));
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it.each(fixtures)('%s applies the explicit work-scope policy', async (name, args) => {
    h.policy = { mode: 'enforce', allowHarnesses: ['A'] };
    const { handler, result } = await dispatch(name, args('B'));
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
  });

  it('checks all batch rows and all shadowed selectors atomically in either order', async () => {
    for (const bad of ['C', 'unknown', 'excluded']) {
      h.policy = { mode: 'enforce', allowHarnesses: ['A', 'B', 'C', 'unknown'] };
      for (const pair of [['A', bad], [bad, 'A']]) {
        for (const name of ['work_items:claim', 'work_items:checkpoint']) {
          const { handler } = await dispatch(name, { items: pair.map((harness, i) => ({ id: `WI-${i}`, harness })) });
          expect(handler).not.toHaveBeenCalled();
        }
        const { handler: memory } = await dispatch('memory:list', { harness_slug: pair[0], hive_slug: pair[1] });
        expect(memory).not.toHaveBeenCalled();
        const { handler: facts } = await dispatch('facts:list', { scope: 'harness', scopeRef: pair[0], ref: pair[1] });
        expect(facts).not.toHaveBeenCalled();
      }
    }
    h.policy = null;
    const { handler } = await dispatch('work_items:claim', { items: [{ harness: 'A' }, { harness: 'B' }] });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves A → B → A defaults and clamps workspace arguments', async () => {
    const first = await dispatch('work_items:get', {});
    const explicit = await dispatch('work_items:get', { harness: 'B', workspace: 'foreign', workspaceId: 'foreign' });
    const last = await dispatch('work_items:get', {});
    expect(first.handler.mock.calls[0][0].harnessSlug).toBe('A');
    expect(explicit.handler.mock.calls[0][0].harnessSlug).toBe('B');
    expect(explicit.handler.mock.calls[0][1]).toMatchObject({ workspace: 'workspace', workspaceId: 'workspace' });
    expect(last.handler.mock.calls[0][0].harnessSlug).toBe('A');
    expect(caller.harnessSlug).toBe('A');
  });
});

it('does not derive authority from arguments, restricted roles, power profiles or disabled clamps', async () => {
  for (const restricted of [
    { ...caller, isSuperuser: false }, { ...caller, role: 'worker' }, { ...caller, profile: 'power' },
  ]) {
    expect(await applySuperuserProjectPolicy('work_items:get', restricted,
      { harness: 'B', role: 'operator', isSuperuser: true, profile: 'engineer' }, true)).toBeNull();
  }
  expect(await applySuperuserProjectPolicy('work_items:get', caller, { harness: 'B' }, false)).toBeNull();
});

it('preserves non-project labels and exact routine targets without rebinding selection', async () => {
  h.resolve.mockResolvedValue(null);
  for (const [name, args] of [
    ['dev:build_status', { harness: 'foreign-diagnostic-label' }],
    ['docs:get', { harness: 'engineering' }],
    ['routines:list', { installSlug: '@singleton', name: 'exact-routine' }],
    ['routines:set', { installSlug: 'workspace', name: 'exact-routine' }],
    ['routines:fire', { harness: '@singleton', name: 'exact-routine' }],
  ] as Array<[string, Record<string, unknown>]>) {
    expect(await applySuperuserProjectPolicy(name, caller, args, true))
      .toMatchObject({ ok: true, args, effectiveHarnessSlug: 'A' });
  }
  expect(h.resolve).not.toHaveBeenCalled();
  for (const [name, args] of [
    ['work_items:get', { harness: 'engineering' }],
    ['routines:list', { installSlug: '@singleton' }],
    ['routines:list', { installSlug: '@singleton', name: 'exact-routine', rollup: true }],
    ['routines:fire', { harness: '@singleton', name: '*' }],
    ['routines:set', { harness: '@singleton', name: 'exact-routine' }],
  ] as Array<[string, Record<string, unknown>]>) {
    expect(await applySuperuserProjectPolicy(name, caller, args, true)).toMatchObject({ ok: false });
  }
});

it('keeps targetless calls, creation exemptions, policy contents and launch member text inert', async () => {
  for (const [name, args] of [
    ['mode:get', {}], ['facts:list', { scope: 'harness' }],
    ['harness:create', { slug: 'new-project', pot: 'B' }],
    ['workspace:work_scope', { op: 'set', allowHarnesses: ['C', 'unknown'] }],
    ['capability:launch-agent', { members: [{ brief: 'harness C', feature: 'C', model: 'C' }] }],
    ['tools:invoke', { name: 'work_items:get', args: { harness: 'C' } }],
  ] as Array<[string, Record<string, unknown>]>) {
    const result = await applySuperuserProjectPolicy(name, { ...caller, harnessSlug: '*' }, args, true);
    expect(result).toMatchObject({ ok: true, effectiveHarnessSlug: '*' });
  }
  expect(h.resolve.mock.calls.every(([, slug]) => slug === 'B')).toBe(true);
});
