/**
 * outbox-drain-fanout-schema-mismatch.test.ts — EI-13920 ("outbox-drain harness_plans
 * fan-out fails on every key: column \"follow_blockers\" does not exist — schema drift
 * between drain code and DB").
 *
 * Live incident: a fan-out query referencing a column/table the live DB schema doesn't
 * have fails IDENTICALLY for every row of that table, on every drain tick, forever (until
 * a migration lands or the code is fixed) — observed as the same "column ... does not
 * exist" line repeating once per plan key, per tick, unboundedly (drowning the log with a
 * fault a retry can never fix). This pins the durable fix: a schema-mismatch fan-out
 * failure (Postgres SQLSTATE 42703 undefined_column / 42P01 undefined_table) is logged
 * loudly ONCE per (table, code, message) signature — not once per row per tick — while a
 * non-schema-mismatch fan-out failure keeps its existing per-occurrence logging (those may
 * be transient/data-specific and are worth seeing every time).
 */
import { describe, expect, it, vi } from 'vitest';
import { drainOutboxOnce } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake: serves `rowsOnce` on the first undrained-batch SELECT,
 *  empty thereafter; the GC DELETE + drained_at UPDATE both no-op. Mirrors the fixture
 *  already used by outbox-drain-row-quarantine.test.ts. */
function fakePg(rowsOnce: unknown[]) {
  let served = false;
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      if (served) {
        const r = [] as unknown[] & { count?: number };
        r.count = 0;
        return r;
      }
      served = true;
      return rowsOnce as unknown[] & { count?: number };
    }
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  return tag as unknown as Parameters<typeof drainOutboxOnce>[1];
}

function fakeHandle(): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append: async () => {},
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

function outboxRow(id: number, tableName: string, key: string) {
  return { id, table_name: tableName, op: 'put' as const, key, row: { id: key }, ts: id, op_hlc: null };
}

function pgError(code: string, message: string): Error {
  const e = new Error(message);
  (e as unknown as { code: string }).code = code;
  return e;
}

describe('outbox-drain fan-out schema-mismatch dedup (EI-13920)', () => {
  it('logs a 42703 (undefined_column) fan-out failure ONCE for the table, not once per row', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [
        outboxRow(1, 'harness_plans', 'plan-a'),
        outboxRow(2, 'harness_plans', 'plan-b'),
        outboxRow(3, 'harness_plans', 'plan-c'),
      ];
      const pg = fakePg(rows);
      const fanout = vi.fn(async () => {
        throw pgError('42703', 'column "follow_blockers" does not exist');
      });

      const drained = await drainOutboxOnce(fakeHandle(), pg, { fanout });

      expect(drained).toBe(3); // fan-out failure is best-effort — never blocks draining
      expect(fanout).toHaveBeenCalledTimes(3); // every row's fan-out was still attempted

      const schemaMismatchLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('FAN-OUT SCHEMA MISMATCH'),
      );
      expect(schemaMismatchLines).toHaveLength(1); // ONE loud line despite 3 failing rows
      expect(String(schemaMismatchLines[0][0])).toContain('harness_plans');
      expect(String(schemaMismatchLines[0][0])).toContain('42703');
      expect(String(schemaMismatchLines[0][0])).toContain('follow_blockers');

      // The old per-row "fan-out failed" line must NOT also fire — else a schema
      // mismatch would double-log under both formats.
      const oldStyleLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('[outbox-drain] fan-out failed'),
      );
      expect(oldStyleLines).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a non-schema-mismatch fan-out failure is NOT deduped — every occurrence still logs', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [
        outboxRow(10, 'harness_features_consolidated', 'F-1'),
        outboxRow(11, 'harness_features_consolidated', 'F-2'),
      ];
      const pg = fakePg(rows);
      const fanout = vi.fn(async () => {
        throw new Error('connection reset by peer');
      });

      const drained = await drainOutboxOnce(fakeHandle(), pg, { fanout });

      expect(drained).toBe(2);
      const oldStyleLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('[outbox-drain] fan-out failed'),
      );
      expect(oldStyleLines).toHaveLength(2); // not a schema mismatch — every row still logged
      const schemaMismatchLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('FAN-OUT SCHEMA MISMATCH'),
      );
      expect(schemaMismatchLines).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a 42P01 (undefined_table) fan-out failure is also treated as a schema mismatch and deduped', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [
        outboxRow(20, 'harness_issues_consolidated', 'I-1'),
        outboxRow(21, 'harness_issues_consolidated', 'I-2'),
      ];
      const pg = fakePg(rows);
      const fanout = vi.fn(async () => {
        throw pgError('42P01', 'relation "harness_shared.some_removed_table" does not exist');
      });

      await drainOutboxOnce(fakeHandle(), pg, { fanout });

      const schemaMismatchLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('FAN-OUT SCHEMA MISMATCH'),
      );
      expect(schemaMismatchLines).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('two DIFFERENT tables each hitting their own schema mismatch get their own one-time log line', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [
        outboxRow(30, 'harness_plans', 'plan-z'),
        outboxRow(31, 'harness_features_consolidated', 'F-9'),
      ];
      const pg = fakePg(rows);
      const fanout = vi.fn(async (r: { table_name: string }) => {
        throw pgError('42703', `column "distinct_missing_col_for_${r.table_name}" does not exist`);
      });

      await drainOutboxOnce(fakeHandle(), pg, { fanout });

      const schemaMismatchLines = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('FAN-OUT SCHEMA MISMATCH'),
      );
      // Distinct table_name (and distinct message) ⇒ distinct signature ⇒ both logged once each.
      expect(schemaMismatchLines).toHaveLength(2);
    } finally {
      errSpy.mockRestore();
    }
  });
});
