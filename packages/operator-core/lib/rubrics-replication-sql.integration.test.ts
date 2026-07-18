/**
 * rubrics-replication-sql.integration.test.ts — validateRubricReplicationSql against a
 * real migrated Postgres (Docker-gated). Pure extraction is covered unit-only in
 * rubrics-replication-sql.test.ts; this proves the EXPLAIN leg actually catches the
 * EI-10514 repro shape (a drill written against a renamed/nonexistent table or column)
 * and stays clean/non-blocking on a genuinely-runnable drill.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { validateRubricReplicationSql } = await import('./rubrics-replication-sql');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('validateRubricReplicationSql (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('ok:true and no findings for criteria with clean, runnable drill SQL', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'end-to-end-flow',
        replication:
          "REPLICATION DRILL: SELECT tick_at, ideas_generated FROM harness_shared.scout_ticks " +
          "WHERE workspace_id='papercusp-workspace' ORDER BY tick_at DESC LIMIT 5; cross-check accounts:status.",
      },
      { key: 'no-sql-here', replication: 'fleet:assignments { harness } -> read summary.coverage_collisions.' },
    ]);
    expect(result).toEqual({ checked: 1, findings: [], ok: true });
  });

  it('surfaces the EI-10514 repro: a drill referencing a renamed column, keyed by criterion', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'ideation-quality',
        // Authored from memory of the OLD schema — real column is ideas_generated/tick_at.
        replication:
          'SELECT ideas_count, created_at FROM harness_shared.scout_ticks ORDER BY created_at DESC LIMIT 5;',
      },
    ]);
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].criterionKey).toBe('ideation-quality');
    expect(result.findings[0].error.code).toBe('42703');
  });

  it('surfaces a renamed-table repro (routed_ideas → harness_shared.scout_routed_ideas)', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'queen-workitem-selection', replication: 'SELECT * FROM routed_ideas LIMIT 5;' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings[0].error.code).toBe('42P01');
  });

  it('checks every criterion independently and reports each finding', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'a', replication: 'SELECT * FROM harness_shared.harness_plans LIMIT 1;' },
      { key: 'b', replication: 'SELECT * FROM harness_shared.nope_not_a_table LIMIT 1;' },
    ]);
    expect(result.checked).toBe(2);
    expect(result.findings.map((f) => f.criterionKey)).toEqual(['b']);
  });

  it('returns ok:true, checked:0 when no criteria carry any SQL', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'a', replication: 'work_items:get on 3 recently-placed items; compare the brief text.' },
    ]);
    expect(result).toEqual({ checked: 0, findings: [], ok: true });
  });
});
