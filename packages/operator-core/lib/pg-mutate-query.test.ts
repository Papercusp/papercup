import { describe, expect, it } from 'vitest';

import {
  PG_MUTATE_DEFAULT_MAX_AFFECTED,
  PG_MUTATE_HARD_MAX_AFFECTED,
  PgMutateGuardError,
  PgMutateQueryError,
  assertSingleWriteStatement,
  pgMutateQuery,
  primaryWriteTarget,
  writePgMutateOutcomeAudit,
} from './pg-mutate-query';

/**
 * postgres-js-shaped mock: `begin(fn)` hands `fn` a tx whose `unsafe` records
 * every statement; a throwing callback rolls back (postgres-js semantics) and
 * rethrows. `rowsAffected` set ⇒ the DML result carries a `.count` (command
 * tag); left undefined ⇒ count absent and the engine must fall back to
 * `rows.length` (RETURNING-only shape).
 */
function mockClient(opts: { rowsAffected?: number; rows?: Record<string, unknown>[] } = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const state = { beginCalls: 0, committed: false, rolledBack: false };
  const tx = {
    unsafe: async (q: string, params?: unknown[]) => {
      calls.push({ sql: q, params });
      if (/^set local/i.test(q.trim())) return [];
      if (/^insert into harness_shared\.audit_log/i.test(q.trim())) return [];
      const rows = [...(opts.rows ?? [])] as Record<string, unknown>[] & { count?: number };
      if (opts.rowsAffected !== undefined) rows.count = opts.rowsAffected;
      return rows;
    },
  };
  const client = {
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
      state.beginCalls++;
      try {
        const out = await fn(tx);
        state.committed = true;
        return out;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
  };
  return { client: client as never, calls, state };
}

const auditCallsOf = (calls: { sql: string }[]) =>
  calls.filter((c) => /^insert into harness_shared\.audit_log/i.test(c.sql.trim()));

describe('assertSingleWriteStatement', () => {
  it('accepts INSERT / UPDATE+WHERE / DELETE+WHERE, stripping one trailing `;`', () => {
    expect(assertSingleWriteStatement("INSERT INTO t (a) VALUES (1);")).toBe("INSERT INTO t (a) VALUES (1)");
    expect(assertSingleWriteStatement("UPDATE t SET a = 2 WHERE id = 'x'")).toBe("UPDATE t SET a = 2 WHERE id = 'x'");
    expect(assertSingleWriteStatement('DELETE FROM t WHERE id = 1')).toBe('DELETE FROM t WHERE id = 1');
  });

  it('refuses UPDATE / DELETE without a TOP-LEVEL WHERE', () => {
    expect(() => assertSingleWriteStatement('UPDATE t SET a = 2')).toThrow(/top-level WHERE is required on UPDATE/);
    expect(() => assertSingleWriteStatement('DELETE FROM t')).toThrow(/top-level WHERE is required on DELETE/);
  });

  it('a WHERE only inside a subquery does not satisfy the top-level requirement', () => {
    expect(() =>
      assertSingleWriteStatement('UPDATE t SET a = (SELECT max(b) FROM u WHERE u.t_id = t.id)'),
    ).toThrow(PgMutateQueryError);
  });

  it('a WHERE only inside a string literal does not satisfy the requirement', () => {
    expect(() => assertSingleWriteStatement("UPDATE t SET note = 'where true'")).toThrow(
      /top-level WHERE is required/,
    );
  });

  it('redirects SELECT to dev:pg_query', () => {
    expect(() => assertSingleWriteStatement('SELECT * FROM t')).toThrow(/reads go to dev:pg_query/);
  });

  it('refuses DDL with the migrations-only message', () => {
    for (const ddl of [
      'CREATE TABLE x (id int)',
      'ALTER TABLE t ADD COLUMN c int',
      'DROP TABLE t',
      'TRUNCATE t',
    ]) {
      expect(() => assertSingleWriteStatement(ddl)).toThrow(/migrations-only/);
    }
  });

  it('refuses `;`-separated multi-statements', () => {
    expect(() => assertSingleWriteStatement("DELETE FROM t WHERE id = 1; DROP TABLE t")).toThrow(
      /single statement/,
    );
  });

  it('a `;` inside a quoted literal is fine', () => {
    expect(assertSingleWriteStatement("INSERT INTO t (a) VALUES ('a;b')")).toBe(
      "INSERT INTO t (a) VALUES ('a;b')",
    );
  });

  it('INSERT … ON CONFLICT DO UPDATE resolves to insert — no WHERE required', () => {
    const q = 'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a';
    expect(assertSingleWriteStatement(q)).toBe(q);
  });

  describe('WITH (CTE) resolution at depth 0', () => {
    it('accepts WITH + INSERT, and a CTE body SELECT never masks the outer write', () => {
      const q = 'WITH src AS (SELECT id FROM u) INSERT INTO t (a) SELECT id FROM src';
      expect(assertSingleWriteStatement(q)).toBe(q);
    });

    it('WITH + UPDATE still requires the top-level WHERE', () => {
      expect(() => assertSingleWriteStatement('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toThrow(
        /top-level WHERE/,
      );
      const ok = 'WITH x AS (SELECT 1 AS v) UPDATE t SET a = x.v FROM x WHERE t.id = 1';
      expect(assertSingleWriteStatement(ok)).toBe(ok);
    });

    it('refuses a top-level SELECT after the CTE list (even over a writing CTE)', () => {
      expect(() =>
        assertSingleWriteStatement('WITH gone AS (DELETE FROM t WHERE true RETURNING id) SELECT * FROM gone'),
      ).toThrow(/top-level statement is a SELECT/);
    });

    it('refuses a WITH that never reaches a top-level DML verb', () => {
      expect(() => assertSingleWriteStatement('WITH x AS (SELECT 1)')).toThrow(
        /could not find a top-level INSERT\/UPDATE\/DELETE/,
      );
    });
  });

  it('refuses empty and comment-only input', () => {
    expect(() => assertSingleWriteStatement('')).toThrow(/empty statement/);
    expect(() => assertSingleWriteStatement('  -- nothing here\n')).toThrow(/empty statement/);
  });

  // ── falsifiability control ────────────────────────────────────────────────
  // A deliberately-wrong validator (first-word check only). The matrix above is
  // only trustworthy while these calibration cases DISCRIMINATE: the naive
  // implementation must ACCEPT what the real one refuses. If a calibration
  // assertion here ever fails, the matrix has gone weak — fix the matrix, not
  // this control.
  function naiveFirstWordOnly(raw: string): string {
    const first = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!['insert', 'update', 'delete', 'with'].includes(first)) throw new PgMutateQueryError('refused');
    return raw;
  }

  it('CONTROL: the naive validator passes the injections the real one refuses', () => {
    const smuggledDrop = "DELETE FROM t WHERE id = 1; DROP TABLE t";
    const unboundedUpdate = 'UPDATE t SET a = 2';
    expect(naiveFirstWordOnly(smuggledDrop)).toBe(smuggledDrop);
    expect(naiveFirstWordOnly(unboundedUpdate)).toBe(unboundedUpdate);
    expect(() => assertSingleWriteStatement(smuggledDrop)).toThrow(PgMutateQueryError);
    expect(() => assertSingleWriteStatement(unboundedUpdate)).toThrow(PgMutateQueryError);
  });
});

describe('primaryWriteTarget', () => {
  it('finds the DML target, lowercased, schema-qualified or bare', () => {
    expect(primaryWriteTarget('INSERT INTO harness_shared.Foo (a) VALUES (1)')).toBe('harness_shared.foo');
    expect(primaryWriteTarget('UPDATE only Bar SET a = 1 WHERE true')).toBe('bar');
    expect(primaryWriteTarget('DELETE FROM baz WHERE id = 1')).toBe('baz');
  });

  it('returns null when no DML target is present', () => {
    expect(primaryWriteTarget('SELECT 1')).toBeNull();
  });
});

describe('pgMutateQuery', () => {
  it('a refused statement never reaches the client', async () => {
    const m = mockClient();
    await expect(pgMutateQuery('DROP TABLE t', { client: m.client })).rejects.toThrow(PgMutateQueryError);
    expect(m.state.beginCalls).toBe(0);
    expect(m.calls).toEqual([]);
  });

  it('commits within the cap and reports the command-tag count', async () => {
    const m = mockClient({ rowsAffected: 3 });
    const res = await pgMutateQuery("UPDATE t SET a = 1 WHERE b = 2", { client: m.client });
    expect(res.committed).toBe(true);
    expect(res.rowsAffected).toBe(3);
    expect(m.state.committed).toBe(true);
    expect(m.state.rolledBack).toBe(false);
    // txn preamble: statement_timeout then UTC, before the DML
    expect(m.calls[0].sql).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(m.calls[1].sql).toMatch(/set local/i);
    expect(m.calls[1].sql).toMatch(/utc/i);
  });

  it('clamps timeoutMs to the ≥100ms floor in the SET LOCAL', async () => {
    const m = mockClient({ rowsAffected: 0 });
    await pgMutateQuery('DELETE FROM t WHERE id = 1', { client: m.client, timeoutMs: 1 });
    expect(m.calls[0].sql).toBe('SET LOCAL statement_timeout = 100');
  });

  it('falls back to rows.length when the result has no command-tag count', async () => {
    const m = mockClient({ rows: [{ id: 1 }, { id: 2 }] });
    const res = await pgMutateQuery('INSERT INTO t (a) VALUES (1), (2) RETURNING id', { client: m.client });
    expect(res.rowsAffected).toBe(2);
    expect(res.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.fields).toEqual(['id']);
  });

  it(`rolls back over the default cap (${PG_MUTATE_DEFAULT_MAX_AFFECTED}) with the measured count`, async () => {
    const m = mockClient({ rowsAffected: PG_MUTATE_DEFAULT_MAX_AFFECTED + 1 });
    const err = await pgMutateQuery('DELETE FROM t WHERE true', { client: m.client }).catch((e) => e);
    expect(err).toBeInstanceOf(PgMutateGuardError);
    expect((err as PgMutateGuardError).rowsAffected).toBe(PG_MUTATE_DEFAULT_MAX_AFFECTED + 1);
    expect(m.state.rolledBack).toBe(true);
    expect(m.state.committed).toBe(false);
  });

  it('an explicit wider maxAffectedRows admits the same count', async () => {
    const m = mockClient({ rowsAffected: PG_MUTATE_DEFAULT_MAX_AFFECTED + 1 });
    const res = await pgMutateQuery('DELETE FROM t WHERE true', {
      client: m.client,
      maxAffectedRows: PG_MUTATE_DEFAULT_MAX_AFFECTED + 1,
    });
    expect(res.committed).toBe(true);
  });

  it(`maxAffectedRows is clamped to the hard cap (${PG_MUTATE_HARD_MAX_AFFECTED})`, async () => {
    const m = mockClient({ rowsAffected: PG_MUTATE_HARD_MAX_AFFECTED + 1 });
    const err = await pgMutateQuery('DELETE FROM t WHERE true', {
      client: m.client,
      maxAffectedRows: PG_MUTATE_HARD_MAX_AFFECTED * 5,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PgMutateGuardError);
    expect(m.state.rolledBack).toBe(true);
  });

  it('expectedRows is an exact-match guard — mismatch rolls back, match commits', async () => {
    const miss = mockClient({ rowsAffected: 2 });
    const err = await pgMutateQuery('DELETE FROM t WHERE id = 1', {
      client: miss.client,
      expectedRows: 3,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PgMutateGuardError);
    expect(miss.state.rolledBack).toBe(true);

    const hit = mockClient({ rowsAffected: 3 });
    const res = await pgMutateQuery('DELETE FROM t WHERE id = 1', { client: hit.client, expectedRows: 3 });
    expect(res.committed).toBe(true);
  });

  it('dryRun executes, reports, and rolls back — committed:false, no audit row', async () => {
    const m = mockClient({ rowsAffected: 5 });
    const res = await pgMutateQuery('UPDATE t SET a = 1 WHERE b = 2', {
      client: m.client,
      dryRun: true,
      audit: { actor: 'su-test', reason: 'dry-run smoke', workspaceId: 'ws-1' },
    });
    expect(res.committed).toBe(false);
    expect(res.rowsAffected).toBe(5);
    expect(m.state.rolledBack).toBe(true);
    expect(m.state.committed).toBe(false);
    expect(auditCallsOf(m.calls)).toEqual([]);
  });

  it('the row-cap guard still fires under dryRun (guard beats the dry-run report)', async () => {
    const m = mockClient({ rowsAffected: PG_MUTATE_DEFAULT_MAX_AFFECTED + 1 });
    await expect(
      pgMutateQuery('DELETE FROM t WHERE true', { client: m.client, dryRun: true }),
    ).rejects.toBeInstanceOf(PgMutateGuardError);
  });

  it('writes the audit row INSIDE the transaction, atomic with the mutation', async () => {
    const m = mockClient({ rowsAffected: 1 });
    await pgMutateQuery("UPDATE harness_shared.foo SET a = 1 WHERE id = 'x'", {
      client: m.client,
      audit: { actor: 'su-6613215b', reason: 'unit-test repair', workspaceId: 'ws-1' },
    });
    const audits = auditCallsOf(m.calls);
    expect(audits).toHaveLength(1);
    const params = audits[0].params as unknown[];
    // [id, ts, actor, action, subject, detailsJson, workspaceId]
    expect(params[2]).toBe('su-6613215b');
    expect(params[3]).toBe('pg.mutate');
    expect(params[4]).toBe('harness_shared.foo');
    expect(params[6]).toBe('ws-1');
    const details = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(details.outcome).toBe('committed');
    expect(details.rows_affected).toBe(1);
    expect(details.reason).toBe('unit-test repair');
    // atomicity: the audit insert rode the same tx, and the tx committed
    expect(m.state.committed).toBe(true);
  });

  it('no audit opt ⇒ no audit row', async () => {
    const m = mockClient({ rowsAffected: 1 });
    await pgMutateQuery('DELETE FROM t WHERE id = 1', { client: m.client });
    expect(auditCallsOf(m.calls)).toEqual([]);
  });
});

describe('writePgMutateOutcomeAudit (best-effort, non-commit outcomes)', () => {
  it('writes a refused/dry_run outcome row via the supplied client', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const client = { unsafe: async (q: string, params?: unknown[]) => (calls.push({ sql: q, params }), []) };
    await writePgMutateOutcomeAudit(
      { actor: 'su-test', reason: 'unit', workspaceId: 'ws-1' },
      'refused',
      'DROP TABLE t',
      { error: 'ddl' },
      client as never,
    );
    expect(calls).toHaveLength(1);
    const params = calls[0].params as unknown[];
    expect(params[2]).toBe('su-test');
    expect(params[4]).toBe('sql'); // DROP has no DML target → 'sql' fallback
    const details = JSON.parse(params[5] as string) as Record<string, unknown>;
    expect(details.outcome).toBe('refused');
    expect(details.error).toBe('ddl');
  });

  it('never throws — a failing audit write is swallowed', async () => {
    const client = {
      unsafe: async () => {
        throw new Error('audit db down');
      },
    };
    await expect(
      writePgMutateOutcomeAudit(
        { actor: 'su-test', reason: 'unit', workspaceId: 'ws-1' },
        'error',
        'DELETE FROM t WHERE id = 1',
        {},
        client as never,
      ),
    ).resolves.toBeUndefined();
  });
});
