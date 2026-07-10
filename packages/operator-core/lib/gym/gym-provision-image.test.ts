/**
 * Regression: the gym cycle's ephemeral-PG provisioning image must stay in
 * lockstep with the shared integration-test container image (EI-8784).
 *
 * WI-2942 (2026-07-05) bumped the test infra + the embedded operator from
 * PG16 → PG18 to match the shipped PostgreSQL 18.3, but LEFT the gym cycle's
 * own container (`autoloop-cycle.ts`, via `GYM_PROVISION_PG_IMAGE`) on
 * `pgvector/pgvector:pg16`. The gym applies the SAME `000-baseline.sql` the
 * operator ships, so the skew meant the live gym provisioned against a PG major
 * the passing `gym-db-init.integration.test.ts` (which runs on pg18) never
 * exercised. This asserts the two images can't diverge again — a future PG-major
 * bump has to move BOTH or this reds, instead of silently stranding the gym.
 *
 * (The chronic `CREATE DATABASE cannot run inside a transaction block` reds were
 * NOT this skew — that was a postgres.js query-protocol bug, EI-9101, guarded by
 * the `createGymDatabase` describe below.)
 */
import { describe, expect, it } from 'vitest';
import { TEST_PG_IMAGE } from '@papercusp/test-config';
import { GYM_PROVISION_PG_IMAGE, createGymDatabase } from './gym-db-init';

describe('gym provisioning PG image', () => {
  it('matches the shared integration-test container image (no pg16↔pg18 drift)', () => {
    expect(GYM_PROVISION_PG_IMAGE).toBe(TEST_PG_IMAGE);
  });

  it('is a pgvector PG18 superset (matches the shipped/embedded operator, WI-2942)', () => {
    // pgvector superset (the 000-baseline.sql schema has vector(N) columns) at the
    // shipped major (PostgreSQL 18.x). Not the stale pg16 that stranded the gym.
    expect(GYM_PROVISION_PG_IMAGE).toMatch(/^pgvector\/pgvector:pg18$/);
    expect(GYM_PROVISION_PG_IMAGE).not.toContain('pg16');
  });
});

/**
 * EI-9101: `createGymDatabase` MUST issue `CREATE DATABASE` over the SIMPLE query
 * protocol. `CREATE DATABASE` cannot run inside a transaction block, and postgres.js
 * sends a query through the extended (prepared) protocol — an implicit transaction —
 * unless `.simple()` is forced. A bare `unsafe('CREATE DATABASE …')` only happened to
 * work because postgres@3.4.9 defaults a parameterless `unsafe` to simple; that
 * version-fragile default is exactly what died live (45 consecutive gym-cycle reds:
 * `PostgresError: CREATE DATABASE cannot run inside a transaction block`) while the
 * pinned-version integration test stayed green. These no-PG unit tests lock the
 * simple-protocol invariant so a future edit can't silently drop `.simple()` again.
 */
describe('createGymDatabase (EI-9101 — simple protocol)', () => {
  /** A minimal postgres.js `Sql` stand-in that records how CREATE DATABASE was issued. */
  function fakeSql(behavior: 'resolve' | { reject: unknown } = 'resolve') {
    const calls: { query: string; usedSimple: boolean }[] = [];
    const maint = {
      unsafe(query: string) {
        const call = { query, usedSimple: false };
        calls.push(call);
        const settle = () => (behavior === 'resolve' ? Promise.resolve([]) : Promise.reject(behavior.reject));
        // The thenable returned by unsafe(); awaiting it WITHOUT .simple() = extended protocol.
        return {
          simple() {
            call.usedSimple = true;
            return settle();
          },
          then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
            return settle().then(onF, onR);
          },
        };
      },
    };
    return { maint: maint as unknown as import('postgres').Sql, calls };
  }

  it('issues CREATE DATABASE via the simple query protocol, not the extended protocol', async () => {
    const { maint, calls } = fakeSql('resolve');
    await createGymDatabase(maint, 'gym_loop_abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toMatch(/^CREATE DATABASE "gym_loop_abc"$/);
    // The regression guard: without .simple() PostgreSQL rejects with
    // "CREATE DATABASE cannot run inside a transaction block".
    expect(calls[0].usedSimple).toBe(true);
  });

  it('is idempotent — swallows a duplicate_database (42P04) error', async () => {
    const { maint } = fakeSql({ reject: new Error('database "gym_loop_abc" already exists') });
    await expect(createGymDatabase(maint, 'gym_loop_abc')).resolves.toBeUndefined();
    const { maint: m2 } = fakeSql({ reject: Object.assign(new Error('duplicate_database'), { code: '42P04' }) });
    await expect(createGymDatabase(m2, 'gym_loop_abc')).resolves.toBeUndefined();
  });

  it('rethrows a non-duplicate provisioning error', async () => {
    const { maint } = fakeSql({ reject: new Error('permission denied to create database') });
    await expect(createGymDatabase(maint, 'gym_loop_abc')).rejects.toThrow(/permission denied/);
  });

  it('rejects an unsafe database name before touching the connection', async () => {
    const { maint, calls } = fakeSql('resolve');
    await expect(createGymDatabase(maint, 'gym";DROP')).rejects.toThrow(/unsafe gym db name/);
    expect(calls).toHaveLength(0);
  });
});
