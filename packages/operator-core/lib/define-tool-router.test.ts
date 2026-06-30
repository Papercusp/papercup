/**
 * define-tool-router.test — the P-002 tier router (pure, no DB). Locks D-003 routing:
 * composed → a live recipe (mints no cap, no capability required); sandboxed/elevated →
 * a review-gated scaffold (never live); bad shapes → error.
 */
import { describe, it, expect } from 'vitest';
import { routeDefineTool, type DefineToolSpec } from './define-tool-router';

const COMPOSED: DefineToolSpec = {
  name: 'oddsmith:summarize-bets',
  description: 'Summarize open bets by calling list + score.',
  tier: 'composed',
  script: 'const bets = await call("work_items:list", { kind: "bet" }); return bets;',
  toolsUsed: ['work_items:list'],
};

describe('routeDefineTool — composed registers live (no capability needed)', () => {
  it('routes a composed tool to a ComposedRecipeInput keyed by the slugified name', () => {
    const r = routeDefineTool(COMPOSED);
    expect(r.kind).toBe('composition');
    if (r.kind !== 'composition') throw new Error('unreachable');
    expect(r.recipe.id).toBe('oddsmith-summarize-bets');
    expect(r.recipe.title).toBe('oddsmith:summarize-bets');
    expect(r.recipe.script).toBe(COMPOSED.script);
    expect(r.recipe.toolsUsed).toEqual(['work_items:list']);
  });

  it('does NOT require a capability for composed (a composition mints none)', () => {
    const r = routeDefineTool({ ...COMPOSED, capability: undefined });
    expect(r.kind).toBe('composition');
  });

  it('composed without a script → error', () => {
    const r = routeDefineTool({ ...COMPOSED, script: undefined });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).toMatch(/composed tier requires `script`/);
  });

  it('a name that slugifies to empty → error', () => {
    const r = routeDefineTool({ ...COMPOSED, name: '!!!' });
    expect(r.kind).toBe('error');
  });
});

describe('routeDefineTool — sandboxed/elevated route to a review-gated scaffold', () => {
  const base: DefineToolSpec = {
    name: 'oddsmith:fetch-odds',
    description: 'Fetch live odds from an allowlisted host.',
    tier: 'sandboxed-imperative',
    capability: 'net:fetch',
    group: 'oddsmith',
    verb: 'fetch-odds',
  };

  for (const tier of ['sandboxed-imperative', 'elevated'] as const) {
    it(`${tier} → a scaffold result, NOT a live registration, marked review-gated`, () => {
      const r = routeDefineTool({ ...base, tier });
      expect(r.kind).toBe('scaffold');
      if (r.kind !== 'scaffold') throw new Error('unreachable');
      expect(r.result.rail).toBe('review-gated');
      // it emits the skeleton file, never registers anything
      expect(r.result.files[0].path).toBe('packages/operator-core/lib/agent-tools/oddsmith/fetch-odds.ts');
      expect(r.result.files[0].contents).toContain('RUNTIME-DANGEROUS');
    });
  }

  it('a dangerous tier without a capability → error (the cap must be declared for review)', () => {
    const r = routeDefineTool({ ...base, capability: undefined });
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.message).toMatch(/must declare its capability/);
  });

  it('a dangerous tier without group/verb → error', () => {
    const r = routeDefineTool({ ...base, group: undefined });
    expect(r.kind).toBe('error');
  });

  it('forwards firstClass to the scaffold (emits a migration stub)', () => {
    const r = routeDefineTool({ ...base, tier: 'elevated', firstClass: true });
    expect(r.kind).toBe('scaffold');
    if (r.kind !== 'scaffold') throw new Error('unreachable');
    expect(r.result.files.some((f) => f.path.endsWith('.sql'))).toBe(true);
  });
});

describe('routeDefineTool — shape guards', () => {
  it('an unknown tier → error', () => {
    const r = routeDefineTool({ ...COMPOSED, tier: 'godmode' as DefineToolSpec['tier'] });
    expect(r.kind).toBe('error');
  });

  it('an empty description → error', () => {
    const r = routeDefineTool({ ...COMPOSED, description: '  ' });
    expect(r.kind).toBe('error');
  });
});
