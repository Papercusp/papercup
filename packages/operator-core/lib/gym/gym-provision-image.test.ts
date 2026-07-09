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
 * exercised — and every `gym-cycle@gymloopharness` fire died at
 * `CREATE DATABASE cannot run inside a transaction block` (29 consecutive reds)
 * while the byte-identical pg18 test stayed green.
 *
 * This asserts the two images can't diverge again — a future PG-major bump has
 * to move BOTH or this reds, instead of silently stranding the gym.
 */
import { describe, expect, it } from 'vitest';
import { TEST_PG_IMAGE } from '@papercusp/test-config';
import { GYM_PROVISION_PG_IMAGE } from './gym-db-init';

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
