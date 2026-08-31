/**
 * Guard for the LEDGER ADAPTER half of the durable-escalation orphan detector
 * (EI-19339499404613652).
 *
 * The classification rules are guarded next door in
 * `durable-escalation-orphan-scan.test.ts` without a database. What can only
 * go wrong HERE is the translation from ledger rows to the scan's input, and
 * one translation bug is silent and severe:
 *
 *   The scan reads `closedAtMs === null` as OPEN. A row that is TERMINAL but
 *   whose `closed_ts` was never recorded also has a null close time — so
 *   passing it straight through files a CLOSED row into the open population.
 *   That inflates every open count and can manufacture an `orphan-suspect`
 *   verdict out of rows that were resolved correctly. Nothing downstream could
 *   detect it, because the resulting report is perfectly well-formed.
 */
import { describe, expect, it } from 'vitest';

import { sweepDurableEscalations } from './durable-escalation-orphan-sweep';
import type { OrgSql } from './work-items';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);

type FakeLedgerRow = {
  emitter: string | null;
  id: string | null;
  created_at_ms: string | number | null;
  closed_at_ms: string | number | null;
  is_open: boolean;
};

/** Stands in for the org pool's tagged template. The adapter's SQL text is not
 *  under test here — the row translation is — so this ignores the query and
 *  answers with a fixed page, and tolerates the `sql(array)` call form the
 *  query uses to expand the terminal-status list. */
function fakeSql(rows: FakeLedgerRow[]): OrgSql {
  return ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as OrgSql;
}

function openRow(id: string, ageHours: number, emitter = 'system:probe'): FakeLedgerRow {
  return {
    emitter,
    id,
    created_at_ms: NOW - ageHours * HOUR,
    closed_at_ms: null,
    is_open: true,
  };
}

function closedRow(
  id: string,
  ageHours: number,
  closeHours: number,
  emitter = 'system:probe',
): FakeLedgerRow {
  const created = NOW - ageHours * HOUR;
  return {
    emitter,
    id,
    created_at_ms: created,
    closed_at_ms: created + closeHours * HOUR,
    is_open: false,
  };
}

async function sweep(rows: FakeLedgerRow[]) {
  return sweepDurableEscalations(
    { workspaceId: 'papercusp-workspace', nowMs: NOW, scanOptions: { minCloseSample: 5 } },
    fakeSql(rows),
  );
}

describe('sweepDurableEscalations row translation', () => {
  it('DROPS a terminal row with no recorded close time instead of counting it as OPEN', async () => {
    const orphanedClose: FakeLedgerRow = {
      emitter: 'system:probe',
      id: 'terminal-no-close-ts',
      created_at_ms: NOW - 900 * HOUR,
      closed_at_ms: null,
      is_open: false,
    };
    const report = await sweep([
      ...Array.from({ length: 6 }, (_, i) => closedRow(`c${i}`, 500, 1)),
      openRow('genuinely-open', 2),
      orphanedClose,
    ]);

    const finding = report.findings.find((f) => f.emitter === 'system:probe')!;
    // 1 open row, NOT 2 — the terminal-with-null-close row must not appear.
    expect(finding.openCount).toBe(1);
    expect(finding.anomalousOpen.map((r) => r.id)).not.toContain('terminal-no-close-ts');
    // And it is not silently counted as an instant close either.
    expect(finding.closedCount).toBe(6);
    expect(report.rowsScanned).toBe(7);
  });

  it('coerces bigint-as-string timestamps the pg driver returns', async () => {
    const report = await sweep([
      ...Array.from({ length: 6 }, (_, i) => {
        const row = closedRow(`c${i}`, 500, 2);
        return {
          ...row,
          created_at_ms: String(row.created_at_ms),
          closed_at_ms: String(row.closed_at_ms),
        };
      }),
      { ...openRow('o1', 400), created_at_ms: String(NOW - 400 * HOUR) },
    ]);

    const finding = report.findings.find((f) => f.emitter === 'system:probe')!;
    expect(finding.closedCount).toBe(6);
    expect(finding.p95CloseHours).toBeCloseTo(2, 6);
    expect(finding.openCount).toBe(1);
  });

  it('skips rows missing an emitter, an id, or a creation time rather than inventing one', async () => {
    const report = await sweep([
      openRow('good', 5),
      { ...openRow('no-emitter', 5), emitter: null },
      { ...openRow('no-id', 5), id: null },
      { ...openRow('no-created', 5), created_at_ms: null },
      { ...openRow('unparseable', 5), created_at_ms: 'not-a-number' },
    ]);

    expect(report.emittersScanned).toBe(1);
    expect(report.rowsScanned).toBe(1);
    const finding = report.findings.find((f) => f.emitter === 'system:probe')!;
    expect(finding.openCount).toBe(1);
  });

  it('VACUITY CONTROL: an empty ledger page reports zero SCANNED, not a clean verdict', async () => {
    const report = await sweep([]);

    expect(report.findings).toEqual([]);
    // The distinguishing evidence: without these an empty result is
    // indistinguishable from a healthy one.
    expect(report.rowsScanned).toBe(0);
    expect(report.emittersScanned).toBe(0);
    expect(report.emittersWithNoOpenRows).toEqual([]);
  });

  /**
   * PERMANENT POSITIVE CONTROL. The translation above differs from the obvious
   * one by a single guard clause. Without a control, the `openCount === 1`
   * assertion would pass just as happily against a translation that never had
   * the bug to begin with — so this reproduces the UNGUARDED mapping inline and
   * proves the assertion actually discriminates between the two.
   */
  it('CONTROL: the unguarded translation miscounts the same page, and the real one does not', async () => {
    const page: FakeLedgerRow[] = [
      ...Array.from({ length: 6 }, (_, i) => closedRow(`c${i}`, 500, 1)),
      openRow('genuinely-open', 2),
      {
        emitter: 'system:probe',
        id: 'terminal-no-close-ts',
        created_at_ms: NOW - 900 * HOUR,
        closed_at_ms: null,
        is_open: false,
      },
    ];

    // The naive mapping: trust `closed_at_ms` alone, as the scan's own
    // null-means-open contract invites. It files the closed row as open.
    const unguardedOpenCount = page.filter((r) => r.closed_at_ms === null).length;
    expect(unguardedOpenCount).toBe(2);

    const finding = (await sweep(page)).findings.find((f) => f.emitter === 'system:probe')!;
    expect(finding.openCount).toBe(1);
    expect(finding.openCount).not.toBe(unguardedOpenCount);
  });

  it('separates emitters so one emitter\'s closes cannot calibrate another', async () => {
    const report = await sweep([
      ...Array.from({ length: 6 }, (_, i) => closedRow(`f${i}`, 500, 0.1, 'system:fast')),
      openRow('fast-open', 300, 'system:fast'),
      ...Array.from({ length: 6 }, (_, i) => closedRow(`s${i}`, 500, 400, 'system:slow')),
      openRow('slow-open', 300, 'system:slow'),
    ]);

    const byEmitter = Object.fromEntries(report.findings.map((f) => [f.emitter, f.verdict]));
    expect(byEmitter).toEqual({
      'system:fast': 'orphan-suspect',
      'system:slow': 'within-own-norm',
    });
  });
});
