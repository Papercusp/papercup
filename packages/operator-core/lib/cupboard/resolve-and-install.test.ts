/**
 * Unit tests for the install-loop core (tool-distribution-discovery P-001).
 * The algorithm is exercised through a stateful in-memory "world": installs
 * move a unit cupboard→installed and re-derive the catalog, so transitive
 * chains, cycles, and the round cap run end-to-end without git/network/PG.
 */
import { describe, it, expect } from 'vitest';
import { buildPackCatalogView, type PackDescriptor } from '@papercusp/blueprint-distribution';
import type { DerivedPackCatalog } from './pack-catalog';
import { resolveAndInstallDeps, type DepSet, type ResolveAndInstallDeps } from './resolve-and-install';

interface WorldUnit {
  name: string;
  kind: 'plugin' | 'pack';
  tools: string[];
  /** Deps this unit declares — surfaced by installUnit for transitive recursion. */
  declaredDeps?: Partial<DepSet>;
}

function makeCatalog(
  installed: WorldUnit[],
  cupboard: WorldUnit[],
  builtins: string[],
  cupboardReachable = true,
): DerivedPackCatalog {
  const packs: PackDescriptor[] = [
    ...installed.map((u) => ({
      name: u.name,
      tools: u.tools,
      kind: u.kind,
      hasRuntime: u.kind !== 'pack',
      source: 'installed' as const,
    })),
    ...cupboard.map((u) => ({
      name: u.name,
      tools: u.tools,
      kind: u.kind,
      hasRuntime: u.kind !== 'pack',
      source: 'cupboard' as const,
      listingId: `lid-${u.name}`,
    })),
  ];
  const builtinTools = new Set(builtins);
  const view = buildPackCatalogView(packs, builtinTools);
  return { view, packs: view.packs, builtinTools, cupboardReachable };
}

/** A mutable world: installs move units cupboard→installed and recurse on their deps. */
function makeWorld(opts: {
  installed?: WorldUnit[];
  cupboard?: WorldUnit[];
  builtins?: string[];
  cupboardReachable?: boolean;
  /** Force-fail installs for these unit names. */
  failInstalls?: string[];
}): ResolveAndInstallDeps & { installs: string[]; deriveCalls: () => number } {
  const installed = new Map((opts.installed ?? []).map((u) => [u.name, u]));
  const cupboard = new Map((opts.cupboard ?? []).map((u) => [u.name, u]));
  const builtins = opts.builtins ?? [];
  const fail = new Set(opts.failInstalls ?? []);
  const installs: string[] = [];
  let deriveCalls = 0;
  return {
    installs,
    deriveCalls: () => deriveCalls,
    deriveCatalog: async () => {
      deriveCalls++;
      return makeCatalog([...installed.values()], [...cupboard.values()], builtins, opts.cupboardReachable ?? true);
    },
    installUnit: async (u) => {
      if (fail.has(u.name)) return { ok: false, error: 'simulated install failure' };
      const unit = cupboard.get(u.name);
      installs.push(u.name);
      if (unit) {
        cupboard.delete(u.name);
        installed.set(u.name, { ...unit });
        return { ok: true, declaredDeps: unit.declaredDeps };
      }
      return { ok: true };
    },
  };
}

describe('resolveAndInstallDeps', () => {
  it('does nothing when every dep is already satisfied (builtin)', async () => {
    const world = makeWorld({ builtins: ['md.render'] });
    const res = await resolveAndInstallDeps({ tools: ['md.render'] }, world);
    expect(res.ok).toBe(true);
    expect(res.installed).toEqual([]);
    expect(world.installs).toEqual([]);
    expect(res.rounds).toBe(0);
  });

  it('installs the Cupboard pack that provides a declared tool', async () => {
    const world = makeWorld({
      cupboard: [{ name: 'md-tools', kind: 'pack', tools: ['md.render', 'md.lint'] }],
    });
    const res = await resolveAndInstallDeps({ tools: ['md.render'] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual(['md-tools']);
    expect(res.installed).toEqual([
      { name: 'md-tools', kind: 'pack', listingId: 'lid-md-tools', tools: ['md.render', 'md.lint'] },
    ]);
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [] });
  });

  it('resolves a declared pack name directly to its listing', async () => {
    const world = makeWorld({ cupboard: [{ name: 'data-pack', kind: 'pack', tools: ['data.q'] }] });
    const res = await resolveAndInstallDeps({ packs: ['data-pack'] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual(['data-pack']);
  });

  it('installs transitively — a pack whose own deps are installable', async () => {
    const world = makeWorld({
      cupboard: [
        { name: 'A', kind: 'pack', tools: ['a.tool'], declaredDeps: { tools: ['b.tool'] } },
        { name: 'B', kind: 'pack', tools: ['b.tool'] },
      ],
    });
    const res = await resolveAndInstallDeps({ tools: ['a.tool'] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual(['A', 'B']); // A first, then its transitive dep B
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [] });
  });

  it('terminates on a cyclic declaration graph (A↔B), installing each once', async () => {
    const world = makeWorld({
      cupboard: [
        { name: 'A', kind: 'pack', tools: ['a.tool'], declaredDeps: { packs: ['B'] } },
        { name: 'B', kind: 'pack', tools: ['b.tool'], declaredDeps: { packs: ['A'] } },
      ],
    });
    const res = await resolveAndInstallDeps({ packs: ['A'] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs.sort()).toEqual(['A', 'B']);
    expect(res.installed.length).toBe(2);
  });

  it('hard-fails a tool with no provider anywhere (no install attempted)', async () => {
    const world = makeWorld({ builtins: ['known.tool'] });
    const res = await resolveAndInstallDeps({ tools: ['ghost.tool'] }, world);
    expect(res.ok).toBe(false);
    expect(res.stillMissing.tools).toEqual(['ghost.tool']);
    expect(world.installs).toEqual([]);
  });

  it('reports a failed install in stillMissing + advisory', async () => {
    const world = makeWorld({
      cupboard: [{ name: 'flaky', kind: 'pack', tools: ['flaky.tool'] }],
      failInstalls: ['flaky'],
    });
    const res = await resolveAndInstallDeps({ tools: ['flaky.tool'] }, world);
    expect(res.ok).toBe(false);
    expect(res.stillMissing.packs).toEqual(['flaky']);
    expect(res.advisory.some((m) => m.includes('flaky'))).toBe(true);
  });

  it('softens unknown units to advisory when the Cupboard is unreachable', async () => {
    const world = makeWorld({ cupboardReachable: false });
    const res = await resolveAndInstallDeps({ plugins: ['firecrawl'] }, world);
    expect(res.ok).toBe(true); // not a hard failure — a transient outage can't disprove the listing
    expect(res.stillMissing.plugins).toEqual([]);
    expect(res.advisory.some((m) => m.toLowerCase().includes('unreachable'))).toBe(true);
    expect(world.installs).toEqual([]);
  });

  it('honors the round cap on an unbounded dep chain', async () => {
    // installUnit always introduces a brand-new installable dep → would loop forever.
    let n = 0;
    const deps: ResolveAndInstallDeps = {
      maxRounds: 3,
      deriveCatalog: async () => {
        const cupboard: PackDescriptor[] = [];
        for (let i = 0; i <= n + 1; i++) {
          cupboard.push({ name: `p${i}`, tools: [`t${i}`], kind: 'pack', hasRuntime: false, source: 'cupboard', listingId: `lid-p${i}` });
        }
        const view = buildPackCatalogView(cupboard, new Set());
        return { view, packs: view.packs, builtinTools: new Set(), cupboardReachable: true };
      },
      installUnit: async (u) => {
        n++;
        const idx = Number(u.name.slice(1));
        return { ok: true, declaredDeps: { tools: [`t${idx + 1}`] } }; // always one more
      },
    };
    const res = await resolveAndInstallDeps({ tools: ['t0'] }, deps);
    expect(res.rounds).toBe(3);
    expect(res.advisory.some((m) => m.includes('round cap'))).toBe(true);
  });
});
