/**
 * GET /bindings?repo_ids=… — the BATCH repo→Hive lookup
 * (comb-hive-native-sharing P-011), the search panel's "hive exists" badge
 * source (P-010). Exercised through the Hono route with a tiny in-memory D1
 * fake (.all() + bound-id capture); no Workers runtime / network.
 */

import { describe, expect, it } from 'vitest';
import { bindingRoute } from '../routes/binding.ts';
import type { Env } from '../env.ts';

interface HRow {
  id: string;
  listing_kind: string;
  github_repository_id: number;
  hive_pubkey: string | null;
  hive_title: string | null;
  claim_status: string;
  unlisted_at: number | null;
}

/** Captures the ids the route bound, so the cap can be asserted. */
function envWith(harnesses: HRow[]): { env: Env; boundIds: number[] } {
  const boundIds: number[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...b: unknown[]) {
          if (/FROM harnesses[\s\S]*IN \(/i.test(sql)) boundIds.push(...(b as number[]));
          return {
            async all<T>(): Promise<{ results: T[] }> {
              if (/FROM harnesses[\s\S]*IN \(/i.test(sql)) {
                const idset = new Set(b as number[]);
                const results = harnesses.filter(
                  (h) =>
                    idset.has(h.github_repository_id) &&
                    h.listing_kind === 'harness' &&
                    h.unlisted_at == null,
                );
                return { results: results as T[] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, boundIds };
}

const row = (over: Partial<HRow> = {}): HRow => ({
  id: 'h1',
  listing_kind: 'harness',
  github_repository_id: 1,
  hive_pubkey: null,
  hive_title: null,
  claim_status: 'unclaimed',
  unlisted_at: null,
  ...over,
});

async function call(env: Env, qs: string) {
  const app = bindingRoute();
  const res = await app.request(`/bindings${qs}`, undefined, env);
  return { res, body: (await res.json()) as { bindings: Array<Record<string, unknown>> } };
}

describe('GET /bindings (batch repo→Hive lookup, P-011)', () => {
  it('empty / missing repo_ids → { bindings: [] }', async () => {
    const { env } = envWith([]);
    expect((await call(env, '')).body).toEqual({ bindings: [] });
    expect((await call(env, '?repo_ids=')).body).toEqual({ bindings: [] });
    expect((await call(env, '?repo_ids=abc,,-3,0')).body).toEqual({ bindings: [] });
  });

  it('returns one binding per matching active harness listing, with the P-011 shape', async () => {
    const pubkey = 'B'.repeat(43) + '=';
    const { env } = envWith([
      row({ id: 'h1', github_repository_id: 1, hive_pubkey: pubkey, hive_title: 'Demo Hive', claim_status: 'claimed' }),
      row({ id: 'h2', github_repository_id: 2, hive_pubkey: null, hive_title: null, claim_status: 'unclaimed' }),
    ]);
    const { body } = await call(env, '?repo_ids=1,2');
    expect(body.bindings).toHaveLength(2);
    expect(body.bindings).toContainEqual({
      repo_id: 1,
      hive_pubkey: pubkey,
      hive_title: 'Demo Hive',
      claim_status: 'claimed',
      listing_id: 'h1',
    });
    expect(body.bindings).toContainEqual({
      repo_id: 2,
      hive_pubkey: null,
      hive_title: null,
      claim_status: 'unclaimed',
      listing_id: 'h2',
    });
  });

  it('omits repos with no listing, unlisted rows, and non-harness kinds', async () => {
    const { env } = envWith([
      row({ id: 'h1', github_repository_id: 1 }),
      row({ id: 'h2', github_repository_id: 2, unlisted_at: Date.now() }),
      row({ id: 'h3', github_repository_id: 3, listing_kind: 'blueprint' }),
    ]);
    // 4 is queried but has no row at all.
    const { body } = await call(env, '?repo_ids=1,2,3,4');
    expect(body.bindings.map((b) => b.repo_id)).toEqual([1]);
  });

  it('dedups to one binding per repo id when more than one active row matches', async () => {
    const { env } = envWith([
      row({ id: 'h1', github_repository_id: 7 }),
      row({ id: 'h1-dup', github_repository_id: 7 }),
    ]);
    const { body } = await call(env, '?repo_ids=7');
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0].repo_id).toBe(7);
  });

  it('caps the queried id set at 50 (P-011)', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const { env, boundIds } = envWith([]);
    await call(env, `?repo_ids=${ids.join(',')}`);
    expect(boundIds.length).toBe(50);
  });
});
