/**
 * federated-pot-scope — the recurrence guard for EI-18777176681958978.
 *
 * The defect: hive-home-grained rows are WRITTEN under the OWNER-authored (federated) pot
 * scope, while a population of readers passed a joiner's LOCAL handle to `listHiveMembers` /
 * `loadRevokedHivePubkeys` and got an EMPTY set — silently, so a revoked member was never
 * refused. Both values are strings, so nothing could catch it.
 *
 * Three guards live here:
 *   1. TYPE-LEVEL (the one that stops the class): a plain `string` must not type-check where
 *      a `FederatedPotScope` is required. Asserted with @ts-expect-error, so `lint:tsc` fails
 *      if the brand is ever weakened back to `string`.
 *   2. RESOLUTION RULES: the two independent sources, their precedence, and fail-open.
 *   3. READER AGREEMENT: the *ForLocalPot wrappers must read under the scope the WRITERS use,
 *      for a joiner whose local handle differs from the owner's slug.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolveFederatedPotScope,
  unsafeFederatedPotScope,
  type FederatedPotScope,
} from './federated-pot-scope';
import {
  listHiveMembers,
  loadRevokedHivePubkeys,
  // WI-6312: the write/single-row half, guarded below.
  getHiveMember,
  loadHiveMemberDevicePubkeys,
  upsertHiveMember,
  addRevokedHivePubkeys,
  removeHiveMember,
  removeAllHiveMembers,
} from './hive-membership-store';

const WS = 'ws-fps';
const LOCAL = 'my-pot-2'; // the joiner's freeSlug-suffixed local handle
const OWNER = 'my-pot'; // the owner-authored slug the projections write under

/**
 * COMPILE-TIME ONLY — deliberately NEVER INVOKED (these calls would open a real PG
 * connection). `tsc` still typechecks the body, which is the entire point: the two
 * @ts-expect-error lines FAIL THE TYPECHECK if the brand is ever weakened back to `string`,
 * making the bug class unreachable by construction rather than by review.
 */
async function _compileTimeScopeGuards(): Promise<void> {
  // @ts-expect-error a LOCAL handle (plain string) must NOT be assignable to FederatedPotScope
  await listHiveMembers(WS, LOCAL);
  // @ts-expect-error same for the revocation reader — the security-relevant half
  await loadRevokedHivePubkeys(WS, LOCAL);

  // ── WI-6312: the WRITE + single-row half. The read side above was branded first; these
  // six were still `string`, so the identical bug stayed reachable on every write path.
  // Each line documents what the LOCAL handle silently did before the brand.
  // @ts-expect-error single-row read: returned null, indistinguishable from "not a member",
  // which silently DEMOTED a real verified member to read-only (pot/member-tier-gate.ts).
  await getHiveMember(WS, LOCAL, 1);
  // @ts-expect-error device pubkeys: attestations and revocations are columns of ONE row,
  // so a scope mismatch between them is how a revoked device passes an admission check.
  await loadHiveMemberDevicePubkeys(WS, LOCAL, 1);
  // @ts-expect-error the WRITE: a row written under the local handle is invisible to every
  // federated reader, and the write reports success.
  await upsertHiveMember({ workspaceId: WS, potHomeSlug: LOCAL, githubUserId: 1, githubUsername: 'a' });
  // @ts-expect-error revocation write: lands where the admission union never looks, so the
  // revocation silently does nothing.
  await addRevokedHivePubkeys(WS, LOCAL, 1, ['pk']);
  // @ts-expect-error delete-one: deletes 0 rows and returns 0 — indistinguishable from the
  // idempotent "already gone", so a leave that never happened reads clean.
  await removeHiveMember(WS, LOCAL, 1);
  // @ts-expect-error delete-all: a dissolve drops nothing and the members keep federating
  // (the G24 teardown silently no-ops).
  await removeAllHiveMembers(WS, LOCAL);
}

describe('FederatedPotScope — the compile-time guard (EI-18777176681958978)', () => {
  it('refuses a bare string where the federated scope is required', () => {
    // The assertion is made by tsc against _compileTimeScopeGuards above (referenced here so
    // it is never dead-code-eliminated, never called so it never touches PG).
    expect(typeof _compileTimeScopeGuards).toBe('function');
  });

  it('accepts a resolved scope, and a certified one, at the same call', async () => {
    const certified: FederatedPotScope = unsafeFederatedPotScope(OWNER, 'test: owner slug');
    const resolved = await resolveFederatedPotScope(WS, OWNER, {
      seams: {
        canonicalHiveHomeSlug: async () => OWNER,
        getHiveBySlug: async () => null,
      },
    });
    // Both are the string they wrap — the brand is erased at runtime.
    expect(certified).toBe(OWNER);
    expect(resolved).toBe(OWNER);
  });
});

describe('unsafeFederatedPotScope', () => {
  it('refuses an empty scope rather than certifying "no members"', () => {
    expect(() => unsafeFederatedPotScope('', 'why')).toThrow(/empty pot scope/);
    expect(() => unsafeFederatedPotScope('   ', 'why')).toThrow(/empty pot scope/);
  });

  it('passes a non-empty slug through unchanged', () => {
    expect(unsafeFederatedPotScope(OWNER, 'why')).toBe(OWNER);
  });
});

describe('resolveFederatedPotScope — precedence and fail-open', () => {
  it('SOURCE 1 wins: the announce-derived slug (the same resolver the WRITE scope uses)', async () => {
    const getHiveBySlug = vi.fn(async () => ({ canonicalHomeSlug: 'stale-column-value' }));
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      seams: { canonicalHiveHomeSlug: async () => OWNER, getHiveBySlug },
    });
    expect(scope).toBe(OWNER);
    // Source 2 is not even consulted when source 1 answered — reader scope must track the
    // writer's resolver, not a column that may still be mid-reconcile.
    expect(getHiveBySlug).not.toHaveBeenCalled();
  });

  it('SOURCE 1 answering `local` is AUTHORITATIVE — source 2 is not consulted at all', async () => {
    // The owner path (and any non-remote pot): canonicalHiveHomeSlug returns the local slug
    // because that IS where the writers wrote. Two properties are asserted at once —
    // correctness (reader scope == writer scope) and cost (no second PG read on the hot
    // git-sync path, which is also what keeps existing call-shape assertions valid).
    const getHiveBySlug = vi.fn(async () => ({ canonicalHomeSlug: 'should-not-be-used' }));
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      seams: { canonicalHiveHomeSlug: async (_ws: string, slug: string) => slug, getHiveBySlug },
    });
    expect(scope).toBe(LOCAL);
    expect(getHiveBySlug).not.toHaveBeenCalled();
  });

  it('SOURCE 2 corroborates: the migration-686 column answers when the announce read cannot', async () => {
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      seams: {
        canonicalHiveHomeSlug: async () => null, // e.g. no registry entry in this process
        getHiveBySlug: async () => ({ canonicalHomeSlug: OWNER }),
      },
    });
    expect(scope).toBe(OWNER);
  });

  it('FAILS OPEN to the local handle when neither source resolves (today’s behavior)', async () => {
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      seams: { canonicalHiveHomeSlug: async () => null, getHiveBySlug: async () => null },
    });
    expect(scope).toBe(LOCAL);
  });

  it('never throws: a throwing source degrades to the next one, then to the local handle', async () => {
    const bothThrow = await resolveFederatedPotScope(WS, LOCAL, {
      seams: {
        canonicalHiveHomeSlug: async () => {
          throw new Error('no org-pg in this process');
        },
        getHiveBySlug: async () => {
          throw new Error('pots read failed');
        },
      },
    });
    expect(bothThrow).toBe(LOCAL);

    const firstThrows = await resolveFederatedPotScope(WS, LOCAL, {
      seams: {
        canonicalHiveHomeSlug: async () => {
          throw new Error('boom');
        },
        getHiveBySlug: async () => ({ canonicalHomeSlug: OWNER }),
      },
    });
    expect(firstThrows).toBe(OWNER);
  });

  it('is IDEMPOTENT on an already-federated scope (owned pot / a pre-resolved value)', async () => {
    // On an owner, canonical == local: the resolver must return it unchanged, which is what
    // makes it safe to call at sites whose input is sometimes already canonical (boot.ts's
    // hiveHomeProjectionSlug, the hive-scoped rekey path).
    const scope = await resolveFederatedPotScope(WS, OWNER, {
      seams: {
        canonicalHiveHomeSlug: async (_ws: string, slug: string) => slug,
        getHiveBySlug: async (_ws: string, slug: string) => ({ canonicalHomeSlug: slug }),
      },
    });
    expect(scope).toBe(OWNER);
  });

  it('forwards { fresh } to the announce resolver (WI-1378 cache bypass)', async () => {
    const canonicalHiveHomeSlug = vi.fn(async () => OWNER);
    await resolveFederatedPotScope(WS, LOCAL, { fresh: true, seams: { canonicalHiveHomeSlug } });
    expect(canonicalHiveHomeSlug).toHaveBeenCalledWith(WS, LOCAL, { fresh: true });
    canonicalHiveHomeSlug.mockClear();
    await resolveFederatedPotScope(WS, LOCAL, { seams: { canonicalHiveHomeSlug } });
    expect(canonicalHiveHomeSlug).toHaveBeenCalledWith(WS, LOCAL, undefined);
  });
});

describe('reader agreement — a joiner reads the scope the writers wrote', () => {
  it('the ForLocalPot wrappers read under the OWNER scope, not the local handle', async () => {
    // Simulate the divergent joiner: `pot_members` rows exist ONLY under the owner slug (that
    // is what the hiveScoped projections persist), and NOTHING is written under the local
    // handle. A reader that passes the local handle sees an empty set — the bug.
    const rowsByScope: Record<string, { revoked: string[] }> = {
      [OWNER]: { revoked: ['revoked-device'] },
    };
    const readUnderScope = (scope: string) => rowsByScope[scope]?.revoked ?? [];

    // The scope the wrappers resolve to is what decides the outcome.
    const scope = await resolveFederatedPotScope(WS, LOCAL, {
      seams: { canonicalHiveHomeSlug: async () => OWNER, getHiveBySlug: async () => null },
    });
    expect(readUnderScope(scope)).toEqual(['revoked-device']);
    // …and the pre-fix behavior, kept here as the falsifier: had the reader kept the local
    // handle, the revocation set would be EMPTY and the revoked device admitted.
    expect(readUnderScope(LOCAL)).toEqual([]);
  });
});
