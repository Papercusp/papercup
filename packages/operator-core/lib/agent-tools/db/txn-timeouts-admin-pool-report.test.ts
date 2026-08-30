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
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import tool, { adminPoolTimeoutReport, type AdminPoolDefaultObservation } from './txn-timeouts';

/**
 * Every case injects an observation, because the DEFAULT observer talks to the live
 * org-admin pool. Injecting it is what makes each branch reachable deterministically;
 * `buildConnectionOptions` is still the real one, for the reason stated in the header.
 */
const observing = (o: AdminPoolDefaultObservation) => () => Promise.resolve(o);
const NO_POOL_DEFAULT = observing({ status: 'observed', poolDefaultMs: 0, source: 'default', roleName: 'harness_admin' });

describe('EI-21866253550551759 — adminPool applied-vs-stored', () => {
  it('reports a configured cap as NOT applied at connect when behind PgBouncer', async () => {
    const r = await adminPoolTimeoutReport(30_000, { resolvedMs: 30_000, pooled: true, observe: NO_POOL_DEFAULT });

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
  it('reports the SAME configured cap as applied at connect when NOT pooled', async () => {
    const r = await adminPoolTimeoutReport(30_000, {
      resolvedMs: 30_000,
      pooled: false,
      // A startup parameter becomes the session's reset value, so the observation
      // agrees with the derivation on this path — that is the consistent state.
      observe: observing({ status: 'observed', poolDefaultMs: 30_000, source: 'client', roleName: 'harness_admin' }),
    });

    expect(r.behindPgBouncer).toBe(false);
    expect(r.appliedAtConnect).toBe(true);
    expect(r.appliedStatementTimeoutMs).toBe(30_000);
    expect(r.bounds).not.toMatch(/UNBOUNDED/);
  });

  it('distinguishes a stored-but-inert value (kill-switch OFF) from a genuine 0', async () => {
    const inert = await adminPoolTimeoutReport(30_000, { resolvedMs: 0, pooled: false, observe: NO_POOL_DEFAULT });
    expect(inert.storedMs).toBe(30_000);
    expect(inert.resolvedMs).toBe(0);
    expect(inert.appliedAtConnect).toBe(false);
    expect(inert.why).toMatch(/INERT/);

    const off = await adminPoolTimeoutReport(0, { resolvedMs: 0, pooled: false, observe: NO_POOL_DEFAULT });
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

/**
 * WI-1194246 — the report must OBSERVE enforcement, not only derive it.
 *
 * A role-level `ALTER ROLE harness_admin SET statement_timeout = …` is applied by the
 * SERVER at session start, so `buildConnectionOptions` (which reports what the CLIENT
 * would send) is structurally blind to it. Without an observation the report would
 * answer "not applied" about a pool that is in fact being capped — the same
 * applied-vs-stored dishonesty as EI-21866253550551759, inverted.
 */
describe('WI-1194246 — adminPool observed-vs-derived', () => {
  it('reports a ROLE-LEVEL default as ENFORCED even though nothing is sent at connect', async () => {
    // The post-rollout state: pooled, no connect-time cap configured at all
    // (resolvedMs 0), yet every bare pool query resets to 30s via the role default.
    const r = await adminPoolTimeoutReport(0, {
      resolvedMs: 0,
      pooled: true,
      observe: observing({ status: 'observed', poolDefaultMs: 30_000, source: 'user', roleName: 'harness_admin' }),
    });

    // The derivation is unchanged and still honest about what the CLIENT sends...
    expect(r.appliedAtConnect).toBe(false);
    expect(r.appliedStatementTimeoutMs).toBeNull();
    // ...but the verdict a reader acts on now comes from the observation.
    expect(r.enforcedOnBarePoolQueries).toBe(true);
    expect(r.why).toMatch(/^ENFORCED:/);
    expect(r.why).toMatch(/source=user/);
    expect(r.bounds).not.toMatch(/UNBOUNDED/);
  });

  /**
   * THE CORE GUARD. An unreadable pool must degrade to UNKNOWN, never to "not
   * enforced" — an absence that is really a failed measurement is exactly the
   * reassuring-but-false answer this whole report exists to stop producing.
   */
  it('degrades an unreadable pool to UNKNOWN, never to a silent "not enforced"', async () => {
    const r = await adminPoolTimeoutReport(30_000, {
      resolvedMs: 30_000,
      pooled: true,
      observe: observing({ status: 'unknown', reason: 'pool wedged' }),
    });

    expect(r.enforcedOnBarePoolQueries).toBeNull();
    expect(r.enforcedOnBarePoolQueries).not.toBe(false);
    expect(r.observed.status).toBe('unknown');
    expect(r.why).toMatch(/UNVERIFIED/);
    expect(r.why).toMatch(/UNKNOWN, not as absent/);
    expect(r.why).toMatch(/pool wedged/);
    // Must NOT assert the absence it could not measure.
    expect(r.bounds).not.toMatch(/UNBOUNDED/);
    expect(r.bounds).toMatch(/UNKNOWN/);
  });

  /**
   * NEGATIVE CONTROL for the two cases above: prove the verdict tracks the
   * OBSERVATION and is not a second derivation from `pooled`/`resolvedMs`. Same
   * inputs as the enforced case, only the observation differs.
   */
  it('flips the verdict on the observation alone, with every other input held fixed', async () => {
    const args = { resolvedMs: 0, pooled: true } as const;
    const enforced = await adminPoolTimeoutReport(0, {
      ...args,
      observe: observing({ status: 'observed', poolDefaultMs: 30_000, source: 'user', roleName: 'harness_admin' }),
    });
    const notEnforced = await adminPoolTimeoutReport(0, { ...args, observe: NO_POOL_DEFAULT });

    expect(enforced.enforcedOnBarePoolQueries).toBe(true);
    expect(notEnforced.enforcedOnBarePoolQueries).toBe(false);
    expect(notEnforced.why).toMatch(/^NOT ENFORCED:/);
    expect(notEnforced.bounds).toMatch(/UNBOUNDED/);
  });

  /**
   * The derivation and the observation can genuinely disagree — a pool built before
   * a config change still carries the old session default. Surfacing that beats
   * silently preferring either side.
   */
  it('surfaces a derived-vs-observed contradiction instead of smoothing it over', async () => {
    const r = await adminPoolTimeoutReport(30_000, {
      resolvedMs: 30_000,
      pooled: false, // ⇒ appliedAtConnect true
      observe: NO_POOL_DEFAULT, // ...but the live pool resets to 0
    });

    expect(r.appliedAtConnect).toBe(true);
    expect(r.enforcedOnBarePoolQueries).toBe(false);
    expect(r.bounds).toMatch(/CONTRADICTION/);
    expect(r.bounds).toMatch(/Trust the observation/);
  });

  /**
   * LIVE-SOURCE GUARD. `pg_settings.setting` is the value of the CURRENT session —
   * including the per-call `SET` the observing query may itself be running under —
   * while `reset_val` is what a BARE checkout gets. Measured on the live pooled
   * org-admin pool 2026-08-30: statement_timeout setting=5000 / reset_val=0.
   * Reading `setting` would therefore report the observer's own SET back as the
   * pool default: a plausible-looking regression that no unit test with an injected
   * observation can catch, because it lives in the default observer.
   */
  // Extracted so the SAME predicate can be aimed at deliberately-wrong fixtures as
  // well as the real file — that is what makes this guard falsifiable without ever
  // mutating the shared tree (a copy-out/restore probe here would race git-sync).
  const observerQuery = (source: string): string => {
    const body = source.slice(source.indexOf('async function observeAdminPoolDefault'));
    const from = body.indexOf('SELECT');
    return from < 0 ? '' : body.slice(from, body.indexOf('`', from));
  };
  // `pg_settings` and `statement_timeout` do not word-match `setting`, so the last
  // clause fails only on a bare `setting` column actually being selected.
  const readsBareCheckoutDefault = (source: string): boolean => {
    const q = observerQuery(source);
    return q.includes('pg_settings') && /reset_val/.test(q) && !/\bsetting\b/.test(q);
  };

  it('observes reset_val (what a bare checkout gets), not the current session setting', () => {
    const src = readFileSync(new URL('./txn-timeouts.ts', import.meta.url), 'utf8');
    expect(readsBareCheckoutDefault(src)).toBe(true);
  });

  it('the reset_val guard actually fails on the regression it exists to catch', () => {
    // THE REGRESSION: reading `setting` reports the observer's own per-call SET back
    // as the pool default (measured live: setting=5000 while reset_val=0).
    const readsSessionSetting = `
      async function observeAdminPoolDefault() {
        const rows = await sql\`
          SELECT setting, source FROM pg_settings WHERE name = 'statement_timeout'
        \`;
      }`;
    expect(readsBareCheckoutDefault(readsSessionSetting)).toBe(false);

    // ...and it is not vacuously true when the observer cannot be located at all,
    // which is how an extraction-based guard silently stops guarding.
    expect(readsBareCheckoutDefault('export const nothingToSeeHere = 1;')).toBe(false);
  });
});
