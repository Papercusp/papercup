/**
 * Deterministic contention proofs for the canonical dependency mutation seam.
 *
 * Plan: dependency-graph-admission-and-health-2026-08-26 P-007.
 * Decisions: D-001, D-002, D-003, D-007, D-012.
 *
 * Unlike scheduler/dependency-concurrency.integration.test.ts, these cases do
 * not merely fire promises at roughly the same time.  A test-only PostgreSQL
 * trigger stops each writer at its first dependency-table DML, after the real
 * SERIALIZABLE transaction has locked endpoints, read the stored graph, built
 * its candidate, and validated that candidate.  The coordinator observes the
 * blocked backends in pg_locks before releasing them.  Every hazardous first
 * snapshot is therefore forced; sleeps and scheduler luck are not part of the
 * proof.
 *
 * Real PostgreSQL (shared reusable testcontainer; Docker required).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import {
  mutateWorkItemDependencies,
  WorkItemDependencyAdmissionError,
  type WorkItemDependencyBatchInput,
  type WorkItemDepEndpoint,
} from './work-item-deps-store';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const EDGE_WS = 'default';
const ITEM_WS = 'tenant-a';
const H = 'admission-harness';
const DEPENDENCY_WRITE_BARRIER_KEY = 4_230_701;
const ENDPOINT_DELETE_COMMIT_KEY = 4_230_702;
const ENDPOINT_REHOME_COMMIT_KEY = 4_230_703;

const issue = (ref: string): WorkItemDepEndpoint => ({ kind: 'issue', ref });
const feature = (ref: string, harness = H): WorkItemDepEndpoint => ({
  kind: 'feature',
  ref: `${harness}#${ref}`,
});

type StoredEdge = {
  blocked_kind: string;
  blocked_ref: string;
  blocker_kind: string;
  blocker_ref: string;
};

type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

let db: FreshPgDb;

const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );

async function seedItem(
  id: string,
  opts: { kind?: string; status?: string; workspaceId?: string; harness?: string } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind,
       created_ts, updated_ts, payload)
    VALUES
      (${opts.workspaceId ?? ITEM_WS}, ${opts.harness ?? H}, ${id}, ${`item ${id}`},
       ${opts.status ?? 'open'}, ${opts.kind ?? 'task'}, 0, 0, '{}'::jsonb)`;
}

async function storedEdges(): Promise<StoredEdge[]> {
  return db.sql<StoredEdge[]>`
    SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${EDGE_WS} AND dep_type = 'blocks'
     ORDER BY blocked_kind, blocked_ref, blocker_kind, blocker_ref`;
}

const edgeKey = (edge: StoredEdge): string =>
  `${edge.blocked_kind}:${edge.blocked_ref}->${edge.blocker_kind}:${edge.blocker_ref}`;

const mutate = (mutations: WorkItemDependencyBatchInput['mutations'], retries?: string[]) =>
  mutateWorkItemDependencies(
    { workspaceId: EDGE_WS, itemWorkspaceId: ITEM_WS, mutations },
    {
      sql: db.sql as Sql,
      retry: {
        maxRetries: 12,
        onRetry: ({ code }) => retries?.push(code),
      },
    },
  );

async function expectCommittedGraphValid(): Promise<void> {
  const result = await mutate([]);
  expect(result.after.stronglyConnectedComponents).toEqual([]);
  expect(result.after.endpointDefects).toEqual([]);
  expect(result.after.strandedClosure).toEqual([]);
}

function expectAdmissionSplit<T>(
  outcomes: readonly Settled<T>[],
  expectedFulfilled: number,
  expectedRejected: number,
): void {
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  expect(fulfilled).toHaveLength(expectedFulfilled);
  expect(rejected).toHaveLength(expectedRejected);
  for (const outcome of rejected) {
    expect((outcome as Extract<Settled<T>, { status: 'rejected' }>).reason).toBeInstanceOf(
      WorkItemDependencyAdmissionError,
    );
  }
}

interface AdvisoryGate {
  waitForSharedWaiters(expected: number): Promise<void>;
  waitForBackendLock(pid: number): Promise<void>;
  waitForTransactionWaiter(): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
}

async function armAdvisoryGate(key: number): Promise<AdvisoryGate> {
  const connection = await db.sql.reserve();
  await connection`SELECT pg_advisory_lock(${key})`;
  let released = false;

  const release = async () => {
    if (released) return;
    await connection`SELECT pg_advisory_unlock(${key})`;
    released = true;
  };

  return {
    async waitForSharedWaiters(expected) {
      await expect
        .poll(
          async () => {
            const [row] = await connection<Array<{ n: number }>>`
              SELECT count(*)::int AS n
                FROM pg_locks
               WHERE locktype = 'advisory'
                 AND classid = 0
                 AND objid = ${key}
                 AND objsubid = 1
                 AND NOT granted`;
            return Number(row?.n ?? 0);
          },
          { timeout: 10_000, interval: 10 },
        )
        .toBe(expected);
    },
    async waitForBackendLock(pid) {
      await expect
        .poll(
          async () => {
            const [row] = await connection<Array<{ wait_event_type: string | null }>>`
              SELECT wait_event_type
                FROM pg_stat_activity
               WHERE datname = current_database() AND pid = ${pid}`;
            return row?.wait_event_type ?? null;
          },
          { timeout: 10_000, interval: 10 },
        )
        .toBe('Lock');
    },
    async waitForTransactionWaiter() {
      await expect
        .poll(
          async () => {
            const [row] = await connection<Array<{ n: number }>>`
              SELECT count(*)::int AS n
                FROM pg_locks l
                JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE a.datname = current_database()
                 AND l.locktype IN ('transactionid', 'tuple')
                 AND NOT l.granted`;
            return Number(row?.n ?? 0);
          },
          { timeout: 10_000, interval: 10 },
        )
        .toBeGreaterThanOrEqual(1);
    },
    release,
    async close() {
      try {
        await release();
      } finally {
        connection.release();
      }
    },
  };
}

async function armDependencyWriteBarrier(): Promise<AdvisoryGate> {
  const gate = await armAdvisoryGate(DEPENDENCY_WRITE_BARRIER_KEY);
  await db.sql`
    UPDATE harness_shared.p007_dependency_write_barrier
       SET active = true, lock_key = ${DEPENDENCY_WRITE_BARRIER_KEY}
     WHERE singleton`;
  return {
    ...gate,
    async close() {
      await db.sql`
        UPDATE harness_shared.p007_dependency_write_barrier
           SET active = false
         WHERE singleton`;
      await gate.close();
    },
  };
}

async function settleAtDependencyWriteBarrier<T>(
  expectedWriters: number,
  start: () => readonly Promise<T>[],
): Promise<Settled<T>[]> {
  const gate = await armDependencyWriteBarrier();
  const pending = Promise.all(start().map(settle));
  try {
    await gate.waitForSharedWaiters(expectedWriters);
    await gate.release();
    return await pending;
  } finally {
    await gate.close();
    await pending;
  }
}

beforeAll(async () => {
  db = await createFreshPgDb('work-item-deps-p007');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `
      CREATE TABLE harness_shared.coord_links (
        id bigserial PRIMARY KEY,
        workspace_id text NOT NULL DEFAULT 'default',
        src_kind text NOT NULL,
        src_ref text NOT NULL,
        dst_kind text NOT NULL,
        dst_ref text NOT NULL,
        rel text NOT NULL
      );
      CREATE UNIQUE INDEX coord_links_edge_uq ON harness_shared.coord_links
        (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel);
      CREATE TABLE harness_shared.coord_threads (
        workspace_id text NOT NULL DEFAULT 'default',
        thread_id text NOT NULL,
        parent_kind text NOT NULL,
        parent_ref text NOT NULL,
        post_count integer NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, thread_id)
      );
      CREATE UNIQUE INDEX coord_threads_parent_uq ON harness_shared.coord_threads
        (workspace_id, parent_kind, parent_ref);
    `,
    )
    .simple();

  // The shipping topology-preserving re-home capability and the P-007 deletion
  // refusal guard. Both real migration files are applied rather than restated.
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '734-repoint-qualified-refs-on-rehome.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '988-work-item-dependency-delete-guard.sql'));

  await db.sql
    .unsafe(
      `
      CREATE TABLE harness_shared.p007_dependency_write_barrier (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        active boolean NOT NULL DEFAULT false,
        lock_key integer NOT NULL
      );
      INSERT INTO harness_shared.p007_dependency_write_barrier
        (singleton, active, lock_key)
      VALUES (true, false, ${DEPENDENCY_WRITE_BARRIER_KEY});

      CREATE OR REPLACE FUNCTION harness_shared.p007_wait_before_dependency_dml()
      RETURNS trigger LANGUAGE plpgsql AS $p007_barrier$
      DECLARE v_key integer;
      BEGIN
        SELECT lock_key INTO v_key
          FROM harness_shared.p007_dependency_write_barrier
         WHERE singleton AND active;
        IF FOUND THEN
          PERFORM pg_advisory_xact_lock_shared(v_key);
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $p007_barrier$;

      CREATE TRIGGER p007_wait_before_dependency_dml_trg
      BEFORE INSERT OR UPDATE OR DELETE ON harness_shared.work_item_deps
      FOR EACH ROW EXECUTE FUNCTION harness_shared.p007_wait_before_dependency_dml();
    `,
    )
    .simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`
    UPDATE harness_shared.p007_dependency_write_barrier
       SET active = false
     WHERE singleton`;
  await db.sql
    .unsafe(
      `
      TRUNCATE harness_shared.work_item_deps,
               harness_shared.work_item_blocked,
               harness_shared.work_items,
               harness_shared.coord_links,
               harness_shared.coord_threads
      RESTART IDENTITY CASCADE;
    `,
    )
    .simple();
});

describe('P-007 deterministic graph-write contention', () => {
  it('reciprocal two-agent writes force one admission loser and one valid edge', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');
    const retries: string[] = [];

    const outcomes = await settleAtDependencyWriteBarrier(2, () => [
      mutate([{ op: 'add', blocked: issue('EI-A'), blocker: issue('EI-B') }], retries),
      mutate([{ op: 'add', blocked: issue('EI-B'), blocker: issue('EI-A') }], retries),
    ]);

    expectAdmissionSplit(outcomes, 1, 1);
    expect(retries).toContain('40001');
    expect(await storedEdges()).toHaveLength(1);
    await expectCommittedGraphValid();
  });

  it('an N-way cycle admits exactly a maximal DAG and rejects the closing writer', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');
    await seedItem('EI-C');

    const outcomes = await settleAtDependencyWriteBarrier(3, () => [
      mutate([{ op: 'add', blocked: issue('EI-A'), blocker: issue('EI-B') }]),
      mutate([{ op: 'add', blocked: issue('EI-B'), blocker: issue('EI-C') }]),
      mutate([{ op: 'add', blocked: issue('EI-C'), blocker: issue('EI-A') }]),
    ]);

    expectAdmissionSplit(outcomes, 2, 1);
    expect(await storedEdges()).toHaveLength(2);
    await expectCommittedGraphValid();
  });

  it('prevents disjoint four-node write skew whose union alone would close a cycle', async () => {
    for (const id of ['EI-A', 'EI-B', 'EI-C', 'EI-D']) await seedItem(id);
    await mutate([
      { op: 'add', blocked: issue('EI-B'), blocker: issue('EI-C') },
      { op: 'add', blocked: issue('EI-D'), blocker: issue('EI-A') },
    ]);

    const outcomes = await settleAtDependencyWriteBarrier(2, () => [
      mutate([{ op: 'add', blocked: issue('EI-A'), blocker: issue('EI-B') }]),
      mutate([{ op: 'add', blocked: issue('EI-C'), blocker: issue('EI-D') }]),
    ]);

    expectAdmissionSplit(outcomes, 1, 1);
    expect(await storedEdges()).toHaveLength(3);
    await expectCommittedGraphValid();
  });

  it('serializes a reciprocal cross-family cycle by typed global identity', async () => {
    await seedItem('EI-A', { kind: 'task' });
    await seedItem('F-B', { kind: 'feature' });

    const outcomes = await settleAtDependencyWriteBarrier(2, () => [
      mutate([{ op: 'add', blocked: issue('EI-A'), blocker: feature('F-B') }]),
      mutate([{ op: 'add', blocked: feature('F-B'), blocker: issue('EI-A') }]),
    ]);

    expectAdmissionSplit(outcomes, 1, 1);
    expect(await storedEdges()).toHaveLength(1);
    await expectCommittedGraphValid();
  });

  it('serializes a reciprocal cycle spanning two harness-qualified feature identities', async () => {
    await seedItem('F-A', { kind: 'feature', harness: 'harness-a' });
    await seedItem('F-B', { kind: 'feature', harness: 'harness-b' });

    const outcomes = await settleAtDependencyWriteBarrier(2, () => [
      mutate([
        {
          op: 'add',
          blocked: feature('F-A', 'harness-a'),
          blocker: feature('F-B', 'harness-b'),
        },
      ]),
      mutate([
        {
          op: 'add',
          blocked: feature('F-B', 'harness-b'),
          blocker: feature('F-A', 'harness-a'),
        },
      ]),
    ]);

    expectAdmissionSplit(outcomes, 1, 1);
    expect(await storedEdges()).toHaveLength(1);
    await expectCommittedGraphValid();
  });

  it('keeps conflicting replace batches atomic while rejecting the cyclic combination', async () => {
    for (const id of ['EI-A', 'EI-B', 'EI-X', 'EI-Y']) await seedItem(id);
    await mutate([
      { op: 'add', blocked: issue('EI-A'), blocker: issue('EI-X') },
      { op: 'add', blocked: issue('EI-B'), blocker: issue('EI-Y') },
    ]);

    const outcomes = await settleAtDependencyWriteBarrier(2, () => [
      mutate([{ op: 'replace', blocked: issue('EI-A'), blockers: [issue('EI-B')] }]),
      mutate([{ op: 'replace', blocked: issue('EI-B'), blockers: [issue('EI-A')] }]),
    ]);

    expectAdmissionSplit(outcomes, 1, 1);
    const finalKeys = (await storedEdges()).map(edgeKey);
    expect([
      ['issue:EI-A->issue:EI-B', 'issue:EI-B->issue:EI-Y'],
      ['issue:EI-A->issue:EI-X', 'issue:EI-B->issue:EI-A'],
    ]).toContainEqual(finalKeys);
    await expectCommittedGraphValid();
  });
});

describe('P-007 endpoint deletion under mutation', () => {
  it('lets a committed edge win, refuses the waiting delete, then permits explicit disposition', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-blocker');
    const barrier = await armDependencyWriteBarrier();
    const mutation = settle(
      mutate([
        {
          op: 'add',
          blocked: issue('EI-dependent'),
          blocker: issue('EI-blocker'),
        },
      ]),
    );
    let deleter: Awaited<ReturnType<Sql['reserve']>> | undefined;
    let deletion: Promise<Settled<unknown>> | undefined;

    try {
      await barrier.waitForSharedWaiters(1);
      deleter = await db.sql.reserve();
      const [{ pid }] = await deleter<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      deletion = settle(
        deleter`
          DELETE FROM harness_shared.work_items
           WHERE workspace_id = ${ITEM_WS} AND feature_id = 'EI-blocker'`,
      );
      await barrier.waitForBackendLock(pid);
      await barrier.release();

      const [mutationOutcome, deletionOutcome] = await Promise.all([mutation, deletion]);
      expect(mutationOutcome.status).toBe('fulfilled');
      expect(deletionOutcome.status).toBe('rejected');
      if (deletionOutcome.status === 'rejected') {
        expect((deletionOutcome.reason as { code?: string }).code).toBe('23503');
        expect(String((deletionOutcome.reason as Error).message)).toMatch(
          /cannot delete dependency endpoint issue:EI-blocker/,
        );
      }
    } finally {
      await barrier.close();
      await mutation;
      if (deletion) await deletion;
      deleter?.release();
    }

    expect(await storedEdges()).toHaveLength(1);
    await expectCommittedGraphValid();

    await mutate([
      {
        op: 'remove',
        blocked: issue('EI-dependent'),
        blocker: issue('EI-blocker'),
      },
    ]);
    await expect(
      db.sql`
        DELETE FROM harness_shared.work_items
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'EI-blocker'`,
    ).resolves.toBeDefined();
    expect(await storedEdges()).toEqual([]);
    await expectCommittedGraphValid();
  });

  it('lets an already-locked delete win and makes the stale mutation reject on retry', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-blocker');
    const gate = await armAdvisoryGate(ENDPOINT_DELETE_COMMIT_KEY);
    const deletion = settle(
      db.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as Sql;
        await tx`
          DELETE FROM harness_shared.work_items
           WHERE workspace_id = ${ITEM_WS} AND feature_id = 'EI-blocker'`;
        await tx`SELECT pg_advisory_xact_lock_shared(${ENDPOINT_DELETE_COMMIT_KEY})`;
      }),
    );
    let mutation: Promise<Settled<unknown>> | undefined;

    try {
      await gate.waitForSharedWaiters(1);
      mutation = settle(
        mutate([
          {
            op: 'add',
            blocked: issue('EI-dependent'),
            blocker: issue('EI-blocker'),
          },
        ]),
      );
      await gate.waitForTransactionWaiter();
      await gate.release();

      const [deletionOutcome, mutationOutcome] = await Promise.all([deletion, mutation]);
      expect(deletionOutcome.status).toBe('fulfilled');
      expect(mutationOutcome.status).toBe('rejected');
      if (mutationOutcome.status === 'rejected') {
        expect(mutationOutcome.reason).toBeInstanceOf(WorkItemDependencyAdmissionError);
      }
    } finally {
      await gate.close();
      await deletion;
      if (mutation) await mutation;
    }

    expect(await storedEdges()).toEqual([]);
    await expectCommittedGraphValid();
  });
});

describe('P-007 topology-preserving re-home under mutation (D-012)', () => {
  it('lets the mutation commit first and the migration-734 trigger re-points it in-place', async () => {
    await seedItem('F-dependent', { kind: 'feature', harness: 'old-harness' });
    await seedItem('EI-blocker');
    const barrier = await armDependencyWriteBarrier();
    const mutation = settle(
      mutate([
        {
          op: 'add',
          blocked: feature('F-dependent', 'old-harness'),
          blocker: issue('EI-blocker'),
        },
      ]),
    );
    let rehoming: Awaited<ReturnType<Sql['reserve']>> | undefined;
    let rehome: Promise<Settled<unknown>> | undefined;

    try {
      await barrier.waitForSharedWaiters(1);
      rehoming = await db.sql.reserve();
      const [{ pid }] = await rehoming<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      rehome = settle(
        rehoming`
          UPDATE harness_shared.work_items
             SET harness_slug = 'new-harness'
           WHERE workspace_id = ${ITEM_WS}
             AND harness_slug = 'old-harness'
             AND feature_id = 'F-dependent'`,
      );
      await barrier.waitForBackendLock(pid);
      await barrier.release();

      const [mutationOutcome, rehomeOutcome] = await Promise.all([mutation, rehome]);
      expect(mutationOutcome.status).toBe('fulfilled');
      expect(rehomeOutcome.status).toBe('fulfilled');
    } finally {
      await barrier.close();
      await mutation;
      if (rehome) await rehome;
      rehoming?.release();
    }

    expect((await storedEdges()).map(edgeKey)).toEqual(['feature:new-harness#F-dependent->issue:EI-blocker']);
    await expectCommittedGraphValid();
  });

  it('lets an already-locked re-home win and rejects a writer holding the old identity', async () => {
    await seedItem('F-dependent', { kind: 'feature', harness: 'old-harness' });
    await seedItem('EI-blocker');
    const gate = await armAdvisoryGate(ENDPOINT_REHOME_COMMIT_KEY);
    const rehome = settle(
      db.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as Sql;
        await tx`
          UPDATE harness_shared.work_items
             SET harness_slug = 'new-harness'
           WHERE workspace_id = ${ITEM_WS}
             AND harness_slug = 'old-harness'
             AND feature_id = 'F-dependent'`;
        await tx`SELECT pg_advisory_xact_lock_shared(${ENDPOINT_REHOME_COMMIT_KEY})`;
      }),
    );
    let mutation: Promise<Settled<unknown>> | undefined;

    try {
      await gate.waitForSharedWaiters(1);
      mutation = settle(
        mutate([
          {
            op: 'add',
            blocked: feature('F-dependent', 'old-harness'),
            blocker: issue('EI-blocker'),
          },
        ]),
      );
      await gate.waitForTransactionWaiter();
      await gate.release();

      const [rehomeOutcome, mutationOutcome] = await Promise.all([rehome, mutation]);
      expect(rehomeOutcome.status).toBe('fulfilled');
      expect(mutationOutcome.status).toBe('rejected');
      if (mutationOutcome.status === 'rejected') {
        expect(mutationOutcome.reason).toBeInstanceOf(WorkItemDependencyAdmissionError);
      }
    } finally {
      await gate.close();
      await rehome;
      if (mutation) await mutation;
    }

    expect(await storedEdges()).toEqual([]);
    const [row] = await db.sql<Array<{ harness_slug: string }>>`
      SELECT harness_slug
        FROM harness_shared.work_items
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'F-dependent'`;
    expect(row?.harness_slug).toBe('new-harness');
    await expectCommittedGraphValid();
  });
});
