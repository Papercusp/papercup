/**
 * txn-timeouts-config — live-configurability-audit-2026-06-20 P-020 (db:txn-timeouts).
 *
 * Covers the D-010 flag-gated SYNC cache: kill-switch OFF (or empty override) ⇒ txnTimeoutsConfig()
 * returns the baked 5s/5s defaults (byte-identical); ON ⇒ a per-field override merges over the defaults.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ flagOn: true, store: new Map<string, unknown>() }));

vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => h.flagOn,
  onFlagChange: () => {},
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async (key: string) => h.store.get(key),
  writeOperatorState: async (key: string, value: unknown) => {
    h.store.set(key, value);
  },
}));

import {
  TXN_TIMEOUTS_DEFAULTS,
  txnTimeoutsConfig,
  adminPoolStatementTimeoutMs,
  refreshTxnTimeoutsConfig,
  setTxnTimeoutsOverride,
  readTxnTimeoutsOverride,
  resetTxnTimeoutsOverride,
} from './txn-timeouts-config';

beforeEach(async () => {
  h.store.clear();
  h.flagOn = true;
  await refreshTxnTimeoutsConfig();
});

describe('txn-timeouts-config — D-010 flag-gated sync cache', () => {
  it('baked defaults are 5s/5s (byte-identical to the pre-config literal)', () => {
    expect(TXN_TIMEOUTS_DEFAULTS).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 5000 });
  });

  it('empty override ⇒ baked defaults', () => {
    expect(txnTimeoutsConfig()).toEqual(TXN_TIMEOUTS_DEFAULTS);
  });

  it('kill-switch OFF ⇒ defaults even after a write (but the store still persists)', async () => {
    h.flagOn = false;
    await refreshTxnTimeoutsConfig();
    await setTxnTimeoutsOverride({ lockTimeoutMs: 15000 });
    expect(txnTimeoutsConfig()).toEqual(TXN_TIMEOUTS_DEFAULTS);
    expect((await readTxnTimeoutsOverride()).lockTimeoutMs).toBe(15000);
  });

  it('ON ⇒ a per-field override merges over the defaults; other fields stay default', async () => {
    await setTxnTimeoutsOverride({ lockTimeoutMs: 15000 });
    expect(txnTimeoutsConfig()).toEqual({
      lockTimeoutMs: 15000,
      statementTimeoutMs: TXN_TIMEOUTS_DEFAULTS.statementTimeoutMs,
    });
  });

  it('a second partial set merges, not replaces', async () => {
    await setTxnTimeoutsOverride({ lockTimeoutMs: 15000 });
    await setTxnTimeoutsOverride({ statementTimeoutMs: 30000 });
    expect(txnTimeoutsConfig()).toEqual({ lockTimeoutMs: 15000, statementTimeoutMs: 30000 });
  });

  it('reset clears the override back to defaults', async () => {
    await setTxnTimeoutsOverride({ lockTimeoutMs: 15000, statementTimeoutMs: 30000 });
    await resetTxnTimeoutsOverride();
    expect(txnTimeoutsConfig()).toEqual(TXN_TIMEOUTS_DEFAULTS);
    expect(await readTxnTimeoutsOverride()).toEqual({});
  });
});

describe('adminPoolStatementTimeoutMs — WI-832 org-pool default (rides the same store/flag)', () => {
  it('defaults to 0 (OFF — no statement_timeout GUC ⇒ today’s unbounded admin pool)', () => {
    expect(adminPoolStatementTimeoutMs()).toBe(0);
  });

  it('ON ⇒ returns the configured override', async () => {
    await setTxnTimeoutsOverride({ adminPoolStatementTimeoutMs: 15000 });
    expect(adminPoolStatementTimeoutMs()).toBe(15000);
  });

  it('kill-switch OFF ⇒ 0 even with a stored override (fail-safe to unbounded)', async () => {
    await setTxnTimeoutsOverride({ adminPoolStatementTimeoutMs: 15000 });
    h.flagOn = false;
    await refreshTxnTimeoutsConfig();
    expect(adminPoolStatementTimeoutMs()).toBe(0);
  });

  it('a non-positive override is clamped to 0 (no accidental sub-floor cap)', async () => {
    await setTxnTimeoutsOverride({ adminPoolStatementTimeoutMs: 0 });
    expect(adminPoolStatementTimeoutMs()).toBe(0);
  });

  it('is a SEPARATE concern — it never pollutes the per-workspace txnTimeoutsConfig() shape', async () => {
    await setTxnTimeoutsOverride({ adminPoolStatementTimeoutMs: 15000 });
    // The locks host destructures {lockTimeoutMs, statementTimeoutMs}; the admin key must not leak in.
    expect(txnTimeoutsConfig()).toEqual(TXN_TIMEOUTS_DEFAULTS);
    expect(Object.keys(txnTimeoutsConfig()).sort()).toEqual(['lockTimeoutMs', 'statementTimeoutMs']);
  });

  it('reset clears the admin-pool override too', async () => {
    await setTxnTimeoutsOverride({ adminPoolStatementTimeoutMs: 15000 });
    await resetTxnTimeoutsOverride();
    expect(adminPoolStatementTimeoutMs()).toBe(0);
    expect(await readTxnTimeoutsOverride()).toEqual({});
  });
});
