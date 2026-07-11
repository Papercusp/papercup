/**
 * blender:ideation-feedback — the OPTIONAL federated priming fold
 * (su-ideate-learning-substrate-2026-07-10 P-012). Pins computeFederatedPriming:
 *  - CONTROL arm (isControlHivePriming, all-zero counts) ⇒ block OMITTED, and the
 *    frontier is never even read (P-016 falsifiability baseline: identical code path,
 *    no foreign priming);
 *  - NON-federated workspace (zero foreign elites) ⇒ block OMITTED (fail-soft empty);
 *  - FEDERATED: foreignElites (foreign rows only, sliced to cfg.foreignElites),
 *    crowdedNiches (depth-aware over local ∪ foreign, sliced to cfg.crowded),
 *    emptyNiches (this hive's disjoint frontier slice, sliced to cfg.empty, never an
 *    occupied niche);
 *  - the default config dep maps owner-steering.federatedPriming ?? DEFAULT.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeFederatedPriming,
  defaultFederatedPrimingDeps,
  type FederatedPrimingDeps,
} from './ideation-feedback';
import type { FrontierEliteView, FrontierScope } from '../../scout/foreign-frontier';
import type { FederatedPrimingConfig } from '../../scout/federated-priming';

vi.mock('../../owner-steering', () => ({ getOwnerSteering: vi.fn() }));
import { getOwnerSteering } from '../../owner-steering';
const mockSteering = vi.mocked(getOwnerSteering);

const SCOPE: FrontierScope = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };
const DEFAULT_CFG: FederatedPrimingConfig = { foreignElites: 3, crowded: 5, empty: 5 };

/** A frontier-elite double. Only nicheKey/fitness/sourceHive/rationale are read by
 *  the fold; the rest is filled with structurally-valid placeholders. */
function elite(
  nicheKey: string,
  fitness: number,
  sourceHive: string | null = null,
  rationale: string | null = null,
): FrontierEliteView {
  const [scope, domain, risk] = nicheKey.split('|') as [string, string, string];
  return {
    nicheKey,
    coords: {
      scope: scope as FrontierEliteView['coords']['scope'],
      domain,
      risk: risk as FrontierEliteView['coords']['risk'],
    },
    candidateId: `c:${nicheKey}:${sourceHive ?? 'local'}`,
    fitness,
    descriptor: {} as FrontierEliteView['descriptor'],
    rationale,
    source: (sourceHive ? 'gym' : 'archive') as FrontierEliteView['source'],
    sourceHive,
  };
}

/** A deps double: each field is a spy; any `over` REPLACES it so the returned
 *  handle IS the one computeFederatedPriming calls. */
function makeDeps(over: { config?: FederatedPrimingConfig; frontier?: FrontierEliteView[] } = {}): FederatedPrimingDeps {
  return {
    readConfig: vi.fn(async () => over.config ?? DEFAULT_CFG),
    readFrontier: vi.fn(async () => over.frontier ?? []),
  };
}

afterEach(() => vi.clearAllMocks());

describe('computeFederatedPriming — omissions', () => {
  it('OMITS the block on the CONTROL arm and never reads the frontier (P-016 baseline)', async () => {
    const deps = makeDeps({ config: { foreignElites: 0, crowded: 0, empty: 0 } });
    const out = await computeFederatedPriming(SCOPE, deps);
    expect(out).toBeUndefined();
    expect(deps.readFrontier).not.toHaveBeenCalled();
  });

  it('OMITS the block on an EMPTY frontier (fail-soft empty)', async () => {
    const out = await computeFederatedPriming(SCOPE, makeDeps({ frontier: [] }));
    expect(out).toBeUndefined();
  });

  it('OMITS the block in a NON-federated workspace (local elites only, no foreign)', async () => {
    const deps = makeDeps({
      frontier: [elite('local|planning|low', 0.9), elite('module|execution|high', 0.7)],
    });
    expect(await computeFederatedPriming(SCOPE, deps)).toBeUndefined();
  });
});

describe('computeFederatedPriming — federated block', () => {
  it('surfaces foreign elites (foreign rows only), crowded niches, and empty niches', async () => {
    const deps = makeDeps({
      frontier: [
        elite('local|planning|low', 0.9), // local — excluded from foreignElites
        elite('module|execution|high', 0.8, 'hive-x', 'reuse the retry ladder'),
        elite('cross-cutting|quality|medium', 0.6, 'hive-y'),
      ],
    });
    const out = await computeFederatedPriming(SCOPE, deps);
    expect(out).toBeDefined();
    // foreignElites = the two foreign rows, best-fitness first; local row excluded.
    expect(out!.foreignElites.map((e) => e.nicheKey)).toEqual([
      'module|execution|high',
      'cross-cutting|quality|medium',
    ]);
    expect(out!.foreignElites.every((e) => typeof e.sourceHive === 'string')).toBe(true);
    expect(out!.crowdedNiches.length).toBeGreaterThan(0);
    // Empty niches are real vocab keys and never an occupied niche.
    const occupied = new Set([
      'local|planning|low',
      'module|execution|high',
      'cross-cutting|quality|medium',
    ]);
    expect(out!.emptyNiches.every((k) => k.includes('|') && !occupied.has(k))).toBe(true);
    expect(out!.emptyNiches.length).toBeLessThanOrEqual(DEFAULT_CFG.empty);
  });

  it('passes foreign rationale through, and omits it when null', async () => {
    const deps = makeDeps({
      frontier: [
        elite('module|execution|high', 0.8, 'hive-x', 'reuse the retry ladder'),
        elite('local|quality|low', 0.5, 'hive-y', null),
      ],
    });
    const out = await computeFederatedPriming(SCOPE, deps);
    expect(out!.foreignElites[0]).toMatchObject({
      nicheKey: 'module|execution|high',
      sourceHive: 'hive-x',
      rationale: 'reuse the retry ladder',
    });
    expect(out!.foreignElites[1]).not.toHaveProperty('rationale');
  });

  it('computes crowding over the FULL union (local ∪ foreign): a shared niche deepens', async () => {
    const deps = makeDeps({
      frontier: [
        elite('local|planning|low', 0.9), //           local
        elite('local|planning|low', 0.8, 'hive-x'), //  foreign, SAME niche
        elite('module|execution|high', 0.7, 'hive-y'), // foreign, distinct niche
      ],
    });
    const out = await computeFederatedPriming(SCOPE, deps);
    const shared = out!.crowdedNiches.find((n) => n.nicheKey === 'local|planning|low');
    expect(shared).toMatchObject({ totalElites: 2, contributingSources: 2 });
  });
});

describe('computeFederatedPriming — count slicing', () => {
  const frontier = [
    elite('module|execution|high', 0.9, 'hive-x'),
    elite('cross-cutting|quality|medium', 0.8, 'hive-y'),
    elite('architectural|knowledge|high', 0.7, 'hive-z'),
    elite('local|planning|low', 0.6), // local occupant so crowding has ≥2 niches
  ];

  it('slices foreignElites to cfg.foreignElites (best-fitness first)', async () => {
    const out = await computeFederatedPriming(SCOPE, makeDeps({ config: { foreignElites: 1, crowded: 5, empty: 5 }, frontier }));
    expect(out!.foreignElites).toHaveLength(1);
    expect(out!.foreignElites[0].nicheKey).toBe('module|execution|high');
  });

  it('a zero foreignElites count still surfaces the block (non-control) with an empty foreignElites list', async () => {
    const out = await computeFederatedPriming(SCOPE, makeDeps({ config: { foreignElites: 0, crowded: 3, empty: 3 }, frontier }));
    expect(out).toBeDefined();
    expect(out!.foreignElites).toEqual([]);
    expect(out!.crowdedNiches.length).toBeGreaterThan(0);
  });

  it('slices crowdedNiches to cfg.crowded', async () => {
    const out = await computeFederatedPriming(SCOPE, makeDeps({ config: { foreignElites: 5, crowded: 1, empty: 5 }, frontier }));
    expect(out!.crowdedNiches).toHaveLength(1);
  });

  it('honors cfg.empty — a zero empty count yields no empty niches', async () => {
    const out = await computeFederatedPriming(SCOPE, makeDeps({ config: { foreignElites: 2, crowded: 2, empty: 0 }, frontier }));
    expect(out).toBeDefined();
    expect(out!.emptyNiches).toEqual([]);
  });
});

describe('defaultFederatedPrimingDeps.readConfig', () => {
  it('maps owner-steering.federatedPriming through resolveFederatedPrimingConfig', async () => {
    mockSteering.mockResolvedValueOnce({
      federatedPriming: { foreignElites: 1, crowded: 2, empty: 3 },
    } as unknown as Awaited<ReturnType<typeof getOwnerSteering>>);
    const cfg = await defaultFederatedPrimingDeps.readConfig('ws-1', 'papercusp');
    expect(cfg).toEqual({ foreignElites: 1, crowded: 2, empty: 3 });
    expect(mockSteering).toHaveBeenCalledWith('ws-1', 'papercusp');
  });

  it('falls back to DEFAULT_FEDERATED_PRIMING when steering has no override', async () => {
    mockSteering.mockResolvedValueOnce({
      federatedPriming: null,
    } as unknown as Awaited<ReturnType<typeof getOwnerSteering>>);
    const cfg = await defaultFederatedPrimingDeps.readConfig('ws-1', 'papercusp');
    expect(cfg).toEqual(DEFAULT_CFG);
  });
});
