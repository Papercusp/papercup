/**
 * Papercusp entity resolvers (tool-arg-referential-integrity-2026-07-19 P-004).
 *
 * Exercises `makeSetResolver` against a stub loader — the cache/suggest/allowed
 * plumbing and, most importantly, the two failure behaviours that keep this
 * layer from becoming an outage: a load failure must PROPAGATE (so the dispatch
 * step fails open) and must never be cached as an empty set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applyEntityRefEnums,
  collectEntityRefs,
  entityRef,
  resolveEntityRefs,
  setEntityEnum,
} from '@papercusp/tooldef';
import {
  invalidateEntityCache,
  makeSetResolver,
  registerPapercuspEntityResolvers,
} from './entity-resolvers-papercusp';

afterEach(() => invalidateEntityCache());

describe('makeSetResolver', () => {
  it('reports values missing from the set and passes the ones present', async () => {
    const r = makeSetResolver('k1', async () => ['papercusp', 'oddsmith']);
    expect(await r(['papercusp'])).toMatchObject({ unknown: [] });
    expect((await r(['nope'])).unknown).toEqual(['nope']);
  });

  it('offers a nearest match for a near-miss', async () => {
    const r = makeSetResolver('k2', async () => ['papercusp', 'oddsmith']);
    const out = await r(['papercsp']);
    expect(out.suggestions?.['papercsp']).toContain('papercusp');
  });

  it('offers no suggestion for something unlike anything known', async () => {
    const r = makeSetResolver('k3', async () => ['papercusp']);
    const out = await r(['zzzzzzzz']);
    expect(out.suggestions?.['zzzzzzzz']).toBeUndefined();
  });

  it('names the full valid set when it is small enough to read', async () => {
    const r = makeSetResolver('k4', async () => ['a', 'b']);
    expect((await r(['x'])).allowed).toEqual(['a', 'b']);
  });

  it('omits a large valid set rather than dumping noise', async () => {
    const many = Array.from({ length: 60 }, (_v, i) => `p${i}`);
    const r = makeSetResolver('k5', async () => many);
    expect((await r(['x'])).allowed).toBeUndefined();
  });

  it('caches the set — a second call does not re-query', async () => {
    const load = vi.fn(async () => ['a']);
    const r = makeSetResolver('k6', load);
    await r(['a']);
    await r(['a']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('invalidateEntityCache forces a reload (a just-created entity resolves at once)', async () => {
    let known = ['a'];
    const r = makeSetResolver('k7', async () => known);
    expect((await r(['b'])).unknown).toEqual(['b']);
    known = ['a', 'b'];
    invalidateEntityCache('k7');
    expect((await r(['b'])).unknown).toEqual([]);
  });

  // The critical one. Caching an empty set on a DB blip would reject EVERY value
  // for the whole TTL — turning a transient failure into a fleet-wide outage of
  // every tool that names that entity. It must throw so the dispatch step's
  // fail-open path takes over instead.
  it('PROPAGATES a load failure and does not cache an empty set', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('pg down');
      return ['a'];
    });
    const r = makeSetResolver('k8', load);
    await expect(r(['a'])).rejects.toThrow('pg down');
    fail = false;
    // No poisoned empty-set cache: the very next call reloads and succeeds.
    expect((await r(['a'])).unknown).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('batches — one load serves every value in the call', async () => {
    const load = vi.fn(async () => ['a', 'b']);
    const r = makeSetResolver('k9', load);
    const out = await r(['a', 'b', 'c', 'd']);
    expect(load).toHaveBeenCalledTimes(1);
    expect(out.unknown).toEqual(['c', 'd']);
  });
});

/**
 * The `role` kind is the one vocabulary here small and static enough to PUBLISH
 * into `tools/list` (P-004b). It is also OPEN — plugins contribute
 * `<plugin>:<role>` ids at runtime — so both halves must tolerate the tail.
 */
describe('role — the published, open vocabulary', () => {
  it('publishes the built-in roles as an enum paired with the namespaced pattern', async () => {
    const schema = z.object({ role: entityRef('role') });
    const out = await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
    const node = (out.properties as Record<string, Record<string, unknown>>).role;
    const arms = node.anyOf as Array<Record<string, unknown>>;
    expect(arms).toHaveLength(2);
    expect(arms[0].enum).toContain('worker');
    expect(arms[0].enum).toContain('cup');
    // The tail: a plugin role can never be enumerated, so it must be allowed by
    // pattern — advertising a closed list would reject legitimate values.
    expect(new RegExp(arms[1].pattern as string).test('myplugin:reviewer')).toBe(true);
  });

  it('accepts a namespaced plugin role at dispatch without consulting the set', async () => {
    const schema = z.object({ role: entityRef('role') });
    const v = await resolveEntityRefs(collectEntityRefs(schema), { role: 'myplugin:reviewer' });
    expect(v).toEqual([]);
  });

  it('still rejects an invented bare role', async () => {
    const schema = z.object({ role: entityRef('role') });
    const v = await resolveEntityRefs(collectEntityRefs(schema), { role: 'engineer' });
    expect(v).toHaveLength(1);
    expect(v[0].value).toBe('engineer');
  });
});

/**
 * The cap is a token budget, not a style rule — the pot/harness sets are far
 * past it, so they must publish NOTHING rather than inflating every session's
 * prompt prefix. (Measured 2026-07-19: pots=142, harness slugs=428.)
 */
describe('over-cap vocabularies publish nothing', () => {
  it('does not publish a pot enum', async () => {
    // The subject here is the CAP DECISION — whether an over-cap set publishes —
    // so it depends on the set's SIZE, never on which pots really exist. Bind a
    // stub over-cap loader: the registered one reads harness_shared.pots, which
    // turned this unit test into a live PG read. It then hung for vitest's full
    // 5s timeout and red-pinned the release gate whenever the org pool was
    // starved (measured 2026-08-12: a bare count(*) on that table could not
    // complete inside 8s). A unit test must not be able to fail because the
    // database is busy.
    setEntityEnum('pot', async () => Array.from({ length: 200 }, (_, i) => `pot-${i}`));
    const schema = z.object({ pot: entityRef('pot') });
    const out = await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
    const node = (out.properties as Record<string, Record<string, unknown>>).pot;
    expect(node.enum).toBeUndefined();
    expect(node.anyOf).toBeUndefined();
  });
});

describe('registration mode', () => {
  afterEach(() => {
    // Keep later tests on the normal unit-tier registration. A live registration
    // is intentionally opt-in and is only used by the recurrence guard below.
    registerPapercuspEntityResolvers({ mode: 'unit' });
    invalidateEntityCache();
  });

  it('defaults pot and harness enum loading to hermetic unit loaders', async () => {
    registerPapercuspEntityResolvers();
    const schema = z.object({ pot: entityRef('pot'), harness: entityRef('harness') });
    const out = await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
    const properties = out.properties as Record<string, Record<string, unknown>>;

    // Empty enum loaders are a deliberate no-op in the advertised schema. Most
    // importantly, this path cannot acquire a database connection from a unit
    // test merely because a tool schema contains an entityRef.
    expect(properties.pot.enum).toBeUndefined();
    expect(properties.pot.anyOf).toBeUndefined();
    expect(properties.harness.enum).toBeUndefined();
    expect(properties.harness.anyOf).toBeUndefined();
  });

  it('allows an explicit live registration for recurrence and integration tests', async () => {
    registerPapercuspEntityResolvers({ mode: 'live' });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    try {
      const schema = z.object({ pot: entityRef('pot') });
      await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
      expect(errors.join('\n')).toContain('UNIT-TIER DB REACH REFUSED');
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * THE RECURRENCE GUARD for EI-20248980966812937.
 *
 * The one-file fix above (binding a stub in the test that happened to fail) did not
 * protect the CLASS: before the unit-aware registration seam, the module-scope call
 * silently armed real DB-backed loaders for every unit test. The default is now safe,
 * and this guard explicitly re-arms live wiring to keep the dangerous path falsifiable.
 * A future test that opts into `live` without the integration tier's DB allowance must
 * fail deterministically rather than hang on a database load and pin `main`.
 *
 * What this asserts is the RAIL, not the symptom: reaching the live DB from the unit tier
 * is refused deterministically and instantly, and says so on a channel that survives the
 * enum overlay's deliberate fail-open catch.
 */
describe('unit-tier DB rail (EI-20248980966812937)', () => {
  /**
   * Re-arm LIVE wiring before each case. This is load-bearing, and the reason is itself
   * an instance of the bug class: `setEntityEnum` mutates a MODULE-SCOPED registry, so
   * the stub bound by "does not publish a pot enum" above outlives that test.
   * `invalidateEntityCache()` clears the cached VALUES, not the REGISTRATION — so without
   * this, these cases silently inherit the stub, never reach the DB, and pass while
   * asserting nothing. (Observed exactly that on the first run: 36ms, zero output.)
   *
   * A guard that passes because the dangerous path was never taken is worse than no guard,
   * so explicit live registration is what makes these assertions falsifiable.
   */
  beforeEach(() => {
    // Live DB-backed registration is explicit: production gets it from the
    // module-scope default, while unit tests must opt in to test this rail.
    registerPapercuspEntityResolvers({ mode: 'live' });
    invalidateEntityCache();
  });

  it('refuses a live-DB reach from the unit tier, loudly, instead of hanging on the pool', async () => {
    // Deliberately DO NOT stub the loader: this is precisely the mistake being guarded.
    // The registered `pot` enum loader reads harness_shared.pots.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    try {
      const schema = z.object({ pot: entityRef('pot') });
      const started = Date.now();
      const out = await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
      const elapsedMs = Date.now() - started;

      // 1. The overlay still fails OPEN — discovery must never break. No enum published.
      const node = (out.properties as Record<string, Record<string, unknown>>).pot;
      expect(node.enum).toBeUndefined();

      // 2. It was REFUSED, not merely slow. The original failure was a 5s vitest timeout
      //    on a connection acquire; anything in that neighbourhood means the rail did not
      //    fire and we are back to a load-sensitive gate leg. Deliberately generous so
      //    this cannot itself become a flaky, load-sensitive assertion — the gap it is
      //    distinguishing is ~0ms vs ~5000ms, so a wide bound still separates them.
      expect(elapsedMs).toBeLessThan(1000);

      // 3. The diagnosis SURVIVED the fail-open catch. Without this channel the refusal
      //    is invisible and the test passes for the wrong reason — which is the failure
      //    mode this whole item is about.
      expect(errors.join('\n')).toContain('UNIT-TIER DB REACH REFUSED');
    } finally {
      spy.mockRestore();
    }
  });

  it('names the concrete fix, so a triager is not left hunting a phantom regression', async () => {
    // The original red cost real hours precisely because it carried no signal about its
    // cause: an anonymous 5s timeout in a file unchanged for three weeks. A rail that
    // refuses without saying how to proceed would repeat that mistake more quickly.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });

    try {
      const schema = z.object({ pot: entityRef('pot') });
      await applyEntityRefEnums(schema, z.toJSONSchema(schema) as Record<string, unknown>);
      const all = errors.join('\n');
      expect(all).toContain('UNIT-TIER DB REACH REFUSED');
      // It must point at the remedy, not merely complain that something was refused.
      expect(all.toLowerCase()).toContain('stub');
    } finally {
      spy.mockRestore();
    }
  });
});
