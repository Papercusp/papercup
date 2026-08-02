/**
 * WI-7083 — the `harness_slugs` fan-out must dedupe on the resolved PLAN SCOPE,
 * not on the requested slug.
 *
 * Plans are HIVE-scoped: `resolvePlanScope` collapses a member harness onto its Hive
 * home, and `listPlanIndexRows` performs that collapse internally. Deduping on the
 * requested slug therefore gave every member of one hive its own batch reading the SAME
 * home plan set — N identical copies of every plan, distinguishable only by the
 * `harness` stamp, which the downstream `${harnessSlug}:${slug}` row-dedupe key cannot
 * see by construction.
 *
 * Measured live before the fix (papercusp hive, members [papercusp, hive-canary]):
 * plans.byHive served 1,820 rows / 1,249,676 B, of which 910 rows were a fabricated
 * second copy stamped with a harness that has ZERO rows in `harness_plans`.
 *
 * The resolvers are injected, so this is a pure unit test — no PG, no registry.
 */
import { describe, expect, it } from 'vitest';

import { resolveFanOutPlanScopes, type FanOutResolvers } from '../list';

/** A registry where `member-a`/`member-b` are members of the `home-hive` Hive. */
function resolvers(overrides: Partial<FanOutResolvers> = {}): FanOutResolvers {
  const hiveHomeOf: Record<string, string> = {
    'home-hive': 'home-hive',
    'member-a': 'home-hive',
    'member-b': 'home-hive',
    'other-hive': 'other-hive',
  };
  return {
    validate: async (slug) => {
      if (!(slug in hiveHomeOf)) throw new Error(`harness '${slug}' not registered in any workspace.`);
      return { harnessSlug: slug };
    },
    scope: async (slug) => {
      const home = hiveHomeOf[slug];
      if (!home) throw new Error(`plans are Hive-scoped, but '${slug}' is not a Hive home`);
      return { harnessSlug: home };
    },
    ...overrides,
  };
}

describe('resolveFanOutPlanScopes (WI-7083)', () => {
  it('collapses every member of one hive onto the single home plan scope', async () => {
    const r = await resolveFanOutPlanScopes(['home-hive', 'member-a', 'member-b'], resolvers());
    // ONE batch, not three — reading the home set three times is what duplicated the rows.
    expect(r.scopes).toEqual(['home-hive']);
    expect(r.unknown).toEqual([]);
  });

  it('collapses members even when the home slug itself was not requested', async () => {
    const r = await resolveFanOutPlanScopes(['member-a', 'member-b'], resolvers());
    expect(r.scopes).toEqual(['home-hive']);
  });

  it('keeps genuinely distinct hives as separate scopes', async () => {
    const r = await resolveFanOutPlanScopes(['member-a', 'other-hive'], resolvers());
    expect(r.scopes).toEqual(['home-hive', 'other-hive']);
  });

  it('dedupes a repeated slug and ignores blank entries before resolving', async () => {
    let validateCalls = 0;
    const base = resolvers();
    const r = await resolveFanOutPlanScopes(['member-a', ' member-a ', '', '   ', 'member-a'], {
      ...base,
      validate: async (s) => {
        validateCalls += 1;
        return base.validate(s);
      },
    });
    expect(r.scopes).toEqual(['home-hive']);
    // 'member-a' and its trimmed-identical repeat resolve once; blanks never reach a resolver.
    expect(validateCalls).toBe(1);
  });

  it('reports an unregistered slug as unknown instead of throwing', async () => {
    const r = await resolveFanOutPlanScopes(['member-a', 'ghost-harness'], resolvers());
    expect(r.scopes).toEqual(['home-hive']);
    expect(r.unknown).toEqual(['ghost-harness']);
  });

  it('reports a registered-but-not-Hive-scoped slug as unknown, contributing no scope', async () => {
    // The `resolvePlanScope` refusal path: the slug VALIDATES (it is registered) but has
    // no plan scope to read. Before this fix that refusal surfaced one batch further down
    // and landed in `batchUnknown`; both collections merge into the same response field.
    const base = resolvers();
    const r = await resolveFanOutPlanScopes(['member-a', 'standalone'], {
      validate: async (s) => (s === 'standalone' ? { harnessSlug: 'standalone' } : base.validate(s)),
      scope: async (s) =>
        s === 'standalone'
          ? Promise.reject(new Error("plans are Hive-scoped, but 'standalone' is not a Hive home"))
          : base.scope(s),
    });
    expect(r.scopes).toEqual(['home-hive']);
    expect(r.unknown).toEqual(['standalone']);
  });

  it('scopes on the VALIDATED slug, so a validator that canonicalizes is honoured', async () => {
    const seen: string[] = [];
    const base = resolvers();
    await resolveFanOutPlanScopes(['MEMBER-A'], {
      validate: async () => ({ harnessSlug: 'member-a' }),
      scope: async (s) => {
        seen.push(s);
        return base.scope(s);
      },
    });
    expect(seen).toEqual(['member-a']);
  });
});
