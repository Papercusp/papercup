/**
 * EI-21866253550551759 — the admin-pool cap must report APPLIED-vs-STORED.
 *
 * WI-832's `adminPoolStatementTimeoutMs` is a CONNECT-TIME GUC. Two independent gates
 * can swallow it while `db:txn-timeouts { op:'get' }` still shows a reassuring stored
 * value: the papercusp-txn-timeouts-config kill-switch (resolver returns 0), and
 * PgBouncer (buildConnectionOptions omits the startup parameter the pooler rejects).
 * Under pooling the cap therefore bounds ONLY what already runs inside boundedOrgTxn /
 * inWorkspaceTxn; a bare pool checkout is unbounded — the class measured at >=180s
 * (a 161s DELETE, a 112s corpus read) while op:get reported 30000.
 *
 * These assertions run against the REAL `buildConnectionOptions`, not a mock of it:
 * the omission under `pooled` is the exact behaviour under test, so mocking it away
 * would assert on the test's own stub. Only the two upstream predicates are injected,
 * which is what makes both branches reachable in one file.
 */
import { describe, it, expect } from 'vitest';
import tool, { adminPoolTimeoutReport } from './txn-timeouts';

describe('EI-21866253550551759 — adminPool applied-vs-stored', () => {
  it('reports a configured cap as NOT applied at connect when behind PgBouncer', () => {
    const r = adminPoolTimeoutReport(30_000, { resolvedMs: 30_000, pooled: true });

    expect(r.behindPgBouncer).toBe(true);
    expect(r.appliedAtConnect).toBe(false);
    expect(r.appliedStatementTimeoutMs).toBeNull();
    // The reader must be told the gap explicitly, not left to infer it from a boolean.
    expect(r.bounds).toMatch(/UNBOUNDED/);
    expect(r.why).toMatch(/PgBouncer/);
  });

  /**
   * TWO-SIDED NEGATIVE CONTROL. Without this the assertions above would still pass if
   * the report hardcoded `appliedAtConnect: false`, or if buildConnectionOptions stopped
   * emitting statement_timeout on EVERY path. This is the case that proves the report
   * actually discriminates on `pooled`.
   */
  it('reports the SAME configured cap as applied at connect when NOT pooled', () => {
    const r = adminPoolTimeoutReport(30_000, { resolvedMs: 30_000, pooled: false });

    expect(r.behindPgBouncer).toBe(false);
    expect(r.appliedAtConnect).toBe(true);
    expect(r.appliedStatementTimeoutMs).toBe(30_000);
    expect(r.bounds).not.toMatch(/UNBOUNDED/);
  });

  it('distinguishes a stored-but-inert value (kill-switch OFF) from a genuine 0', () => {
    const inert = adminPoolTimeoutReport(30_000, { resolvedMs: 0, pooled: false });
    expect(inert.storedMs).toBe(30_000);
    expect(inert.resolvedMs).toBe(0);
    expect(inert.appliedAtConnect).toBe(false);
    expect(inert.why).toMatch(/INERT/);

    const off = adminPoolTimeoutReport(0, { resolvedMs: 0, pooled: false });
    expect(off.why).toMatch(/OFF/);
    expect(off.why).not.toMatch(/INERT/);
  });

  it('no longer claims the cap bounds the admin-pool class "at the source"', () => {
    // The false claim this item was filed against. It read as a guarantee that the
    // whole write class was bounded, which is untrue under the deployed config.
    expect(tool.description).not.toMatch(/at the source/);
    expect(tool.description).toMatch(/PgBouncer/);
  });
});
