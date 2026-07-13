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
  /** Event families this unit PROVIDES (D-003, P-007). */
  events?: Array<{ family: string; keyTemplate: string }>;
  /** Deps this unit declares — surfaced by installUnit for transitive recursion. */
  declaredDeps?: Partial<DepSet>;
}

function makeCatalog(
  installed: WorldUnit[],
  cupboard: WorldUnit[],
  builtins: string[],
  cupboardReachable = true,
  builtinEvents: ReadonlyMap<string, string> = new Map(),
): DerivedPackCatalog {
  const packs: PackDescriptor[] = [
    ...installed.map((u) => ({
      name: u.name,
      tools: u.tools,
      events: u.events ?? [],
      kind: u.kind,
      hasRuntime: u.kind !== 'pack',
      source: 'installed' as const,
    })),
    ...cupboard.map((u) => ({
      name: u.name,
      tools: u.tools,
      events: u.events ?? [],
      kind: u.kind,
      hasRuntime: u.kind !== 'pack',
      source: 'cupboard' as const,
      listingId: `lid-${u.name}`,
    })),
  ];
  const builtinTools = new Set(builtins);
  const view = buildPackCatalogView(packs, builtinTools, builtinEvents);
  return { view, packs: view.packs, builtinTools, cupboardReachable };
}

/** A mutable world: installs move units cupboard→installed and recurse on their deps. */
function makeWorld(opts: {
  installed?: WorldUnit[];
  cupboard?: WorldUnit[];
  builtins?: string[];
  builtinEvents?: ReadonlyMap<string, string>;
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
      return makeCatalog(
        [...installed.values()],
        [...cupboard.values()],
        builtins,
        opts.cupboardReachable ?? true,
        opts.builtinEvents ?? new Map(),
      );
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
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [], events: [] });
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
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [], events: [] });
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

/* ───────────────────────────────────────────────────────────────────────
 * The EVENT dependency axis (D-003, cupboard-public-release P-007).
 *
 * The contract being pinned: a REQUIRED event dep is as hard as a tool dep
 * (a unit whose reaction fires on a family nobody emits is inert, and we say
 * so at install rather than shipping something that silently never fires),
 * while an OPTIONAL one is listen-if-present and never blocks. And crucially:
 * an event dep that a Cupboard unit PROVIDES pulls that unit in through the
 * SAME install loop as a tool dep — that is the whole point of making events
 * an axis rather than a bolted-on side concept.
 * ─────────────────────────────────────────────────────────────────────── */
describe('resolveAndInstallDeps — event deps (D-003)', () => {
  const builtinEvents = new Map([['deploy', 'deploy:<env>']]);

  it('a REQUIRED event family with no provider anywhere is a HARD miss (ok:false), like a missing tool', async () => {
    const world = makeWorld({ builtinEvents });
    const res = await resolveAndInstallDeps({ events: [{ family: 'nobody:emits' }] }, world);
    expect(res.ok).toBe(false);
    expect(res.stillMissing.events).toEqual([{ family: 'nobody:emits' }]);
    expect(world.installs).toEqual([]);
  });

  it('an OPTIONAL event family with no provider does NOT block — install proceeds, advisory records it', async () => {
    const world = makeWorld({ builtinEvents });
    const res = await resolveAndInstallDeps({ events: [{ family: 'nobody:emits', optional: true }] }, world);
    expect(res.ok).toBe(true);
    expect(res.stillMissing.events).toEqual([]);
    expect(res.advisory.join(' ')).toContain('nobody:emits');
    expect(res.advisory.join(' ')).toContain('optional');
  });

  it('a BUILTIN family is satisfied outright — no install, no miss', async () => {
    const world = makeWorld({ builtinEvents });
    const res = await resolveAndInstallDeps({ events: [{ family: 'deploy' }] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual([]);
    expect(res.stillMissing.events).toEqual([]);
  });

  it('an ALREADY-INSTALLED unit’s family is satisfied outright', async () => {
    const world = makeWorld({
      installed: [{ name: 'watcher', kind: 'plugin', tools: [], events: [{ family: 'w:settled', keyTemplate: 'w:settled:<id>' }] }],
      builtinEvents,
    });
    const res = await resolveAndInstallDeps({ events: [{ family: 'w:settled' }] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual([]);
  });

  // The axis actually closing the install loop — an event dep pulls its provider in.
  it('an event family a CUPBOARD unit provides INSTALLS that unit (same loop as a tool dep)', async () => {
    const world = makeWorld({
      cupboard: [{ name: 'canary', kind: 'pack', tools: [], events: [{ family: 'canary:flipped', keyTemplate: 'canary:flipped:<f>' }] }],
      builtinEvents,
    });
    const res = await resolveAndInstallDeps({ events: [{ family: 'canary:flipped' }] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual(['canary']);
    expect(res.installed.map((u) => u.name)).toEqual(['canary']);
    expect(res.stillMissing.events).toEqual([]);
  });

  it('installs a unit whose event provider is pulled in TRANSITIVELY (the installed unit’s own event dep)', async () => {
    const world = makeWorld({
      cupboard: [
        {
          name: 'A',
          kind: 'pack',
          tools: ['a.run'],
          // A itself needs an event that only B provides.
          declaredDeps: { events: [{ family: 'b:ready' }] },
        },
        { name: 'B', kind: 'plugin', tools: [], events: [{ family: 'b:ready', keyTemplate: 'b:ready' }] },
      ],
      builtinEvents,
    });
    const res = await resolveAndInstallDeps({ tools: ['a.run'] }, world);
    expect(res.ok).toBe(true);
    expect(world.installs).toEqual(['A', 'B']); // A first, then its transitive EVENT dep
    expect(res.stillMissing.events).toEqual([]);
  });

  it('a failed install of the event provider leaves the REQUIRED family missing (ok:false)', async () => {
    const world = makeWorld({
      cupboard: [{ name: 'canary', kind: 'pack', tools: [], events: [{ family: 'canary:flipped', keyTemplate: 'x' }] }],
      builtinEvents,
      failInstalls: ['canary'],
    });
    const res = await resolveAndInstallDeps({ events: [{ family: 'canary:flipped' }] }, world);
    expect(res.ok).toBe(false);
    expect(res.stillMissing.events).toEqual([{ family: 'canary:flipped' }]);
  });

  // REQUIRED beats OPTIONAL on merge: a soft transitive re-declaration must never
  // downgrade a hard dep into a silently-skipped one.
  it('the SAME family declared both required and optional stays REQUIRED (strictest wins)', async () => {
    const world = makeWorld({ builtinEvents });
    const res = await resolveAndInstallDeps(
      { events: [{ family: 'x:done' }, { family: 'x:done', optional: true }] },
      world,
    );
    expect(res.ok).toBe(false);
    expect(res.stillMissing.events).toEqual([{ family: 'x:done' }]);
  });

  it('declaring NO events is byte-identical to before (the axis is inert when unused)', async () => {
    const world = makeWorld({ builtins: ['core.tool'] });
    const res = await resolveAndInstallDeps({ tools: ['core.tool'] }, world);
    expect(res.ok).toBe(true);
    expect(res.stillMissing).toEqual({ tools: [], packs: [], plugins: [], events: [] });
    expect(res.advisory).toEqual([]);
  });
});
