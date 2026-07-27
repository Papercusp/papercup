/**
 * ledger-created-at.test.ts — recurrence guard for WI-6443.
 *
 * `PgExperimentLedger.listRecent` mapped `createdAt: (r.created_at as Date).toISOString()`.
 * `as Date` is a type ASSERTION: it silences the compiler and does nothing at
 * runtime. On this read path the driver hands back a STRING, so `.toISOString`
 * was undefined and threw — taking the entire `learning.experiments` read with
 * it. The Experiments view rendered "The experiment registry unavailable
 * (r.created_at.toISOString is not a function)" for every user and had never
 * once displayed an experiment.
 *
 * Nothing caught it for two compounding reasons, both worth stating because they
 * are what this test is really guarding against:
 *   · tsc cannot: the assertion is precisely a promise to the compiler that the
 *     runtime shape is something it has no way to check;
 *   · the Learning-tab sweep reported `experiments ok`, because it asserted only
 *     that a view pane existed — and one did: the pane was faithfully rendering
 *     the failure. A correctly-rendered error read as a pass.
 *
 * So the guard has to be a RUNTIME one, driving listRecent with the shapes a
 * driver actually returns. The integration sibling (ledger.integration.test.ts)
 * needs Docker + PG and asserts persistence; this one is a pure unit test of the
 * boundary coercion, which is where the defect lived.
 */
import { describe, expect, it } from 'vitest';
import { PgExperimentLedger } from './ledger';

/** Minimal tagged-template stand-in for the postgres.js `Sql` handle. */
function fakeSql(rows: Record<string, unknown>[]) {
  return (() => Promise.resolve(rows)) as never;
}

const row = (createdAt: unknown) => ({
  battery_id: 'b1',
  test_id: 't1',
  tier: 'cheap',
  winner: 'arm-a',
  arms: [],
  total_cost_usd: '0.02',
  budget_exhausted: false,
  decision: 'ship',
  created_at: createdAt,
});

describe('WI-6443 — listRecent coerces created_at instead of asserting it is a Date', () => {
  it('does not throw when the driver returns a STRING (the live failure)', async () => {
    const ledger = new PgExperimentLedger(fakeSql([row('2026-07-27T12:34:56.000Z')]));
    // Before the fix this rejected with "r.created_at.toISOString is not a function".
    const out = await ledger.listRecent('papercusp-workspace');
    expect(out).toHaveLength(1);
    expect(out[0]!.createdAt).toBe('2026-07-27T12:34:56.000Z');
  });

  it('still handles a real Date (the shape the cast assumed)', async () => {
    const d = new Date('2026-07-27T12:34:56.000Z');
    const ledger = new PgExperimentLedger(fakeSql([row(d)]));
    const out = await ledger.listRecent('papercusp-workspace');
    expect(out[0]!.createdAt).toBe('2026-07-27T12:34:56.000Z');
  });

  it('handles an epoch number without inventing a bogus date', async () => {
    const ledger = new PgExperimentLedger(fakeSql([row(1785000000000)]));
    const out = await ledger.listRecent('papercusp-workspace');
    expect(out[0]!.createdAt).toBe(new Date(1785000000000).toISOString());
  });

  it('survives an unparseable value rather than taking the whole read down', async () => {
    // The point of the fix is that ONE bad row can no longer fail the query for
    // the entire view — which is exactly how a single cast blanked Experiments.
    const ledger = new PgExperimentLedger(fakeSql([row('not-a-date'), row(null)]));
    const out = await ledger.listRecent('papercusp-workspace');
    expect(out).toHaveLength(2);
    expect(typeof out[0]!.createdAt).toBe('string');
    expect(typeof out[1]!.createdAt).toBe('string');
  });
});
