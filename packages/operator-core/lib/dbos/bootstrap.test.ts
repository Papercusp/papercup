/**
 * bootstrap.test.ts — WI-2790: DBOS's own system-database pool must get extra
 * idle-in-transaction slack (via a startup `options` GUC on its own connection
 * string) WITHOUT touching the cluster-wide EI-49 default any other connection
 * relies on. Pure-function unit tests only (no PG, no DBOS.setConfig/launch).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { withDbosIdleTxGrace } from './bootstrap';

describe('withDbosIdleTxGrace', () => {
  const ENV_KEY = 'PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC';
  const prior = process.env[ENV_KEY];

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prior;
  });

  it('appends a 300s (5min) default idle-in-transaction override as a `?options=` startup GUC', () => {
    delete process.env[ENV_KEY];
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toBe(
      'postgresql://user:pass@host:5432/db?options=' +
        encodeURIComponent('-c idle_in_transaction_session_timeout=300000'),
    );
  });

  it('uses `&options=` (not a second `?`) when the url already carries a query string', () => {
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db?sslmode=require');
    expect(out.startsWith('postgresql://user:pass@host:5432/db?sslmode=require&options=')).toBe(true);
  });

  it('honors PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC when set above the 60s floor', () => {
    process.env[ENV_KEY] = '600';
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=600000'));
  });

  it('clamps a below-floor / non-numeric override up to the 60s floor (never LOWER than the cluster default)', () => {
    process.env[ENV_KEY] = '10';
    let out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=60000'));

    process.env[ENV_KEY] = 'not-a-number';
    out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=300000'));
  });
});
