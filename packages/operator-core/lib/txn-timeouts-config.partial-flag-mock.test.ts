/**
 * RECURRENCE GUARD for EI-19416650993725684 (lifted out of WI-7411).
 *
 * THE CLASS THIS GUARDS: `txn-timeouts-config.ts` must stay IMPORTABLE under a mock of
 * `@papercusp/flags/server` that omits `onFlagChange`. Vitest's mocked-module proxy throws on
 * binding ACCESS, so a module-scope read of that export kills the importing test FILE at
 * collection time — 0 tests run, with an error that names flags/server while pointing at a file
 * that never mentions it:
 *
 *   Error: [vitest] No "onFlagChange" export is defined on the "@papercusp/flags/server" mock
 *
 * BLAST RADIUS (measured 2026-08-03): 116 operator-core test files mock `@papercusp/flags/server`
 * and 96 of them omit `onFlagChange`. Each is one transitive import of
 * `agent-tools/locks/configure.ts` -> `txn-timeouts-config.ts` away from dying this way. Two
 * already did (`agent-tools/loop/arm.test.ts`, `agent-tools/work_items/complete.test.ts`), and
 * were patched per-file under WI-7411 — which fixed the instances, not the class.
 *
 * WHY THIS FILE IS ITS OWN SUITE: the sibling `txn-timeouts-config.test.ts` mocks flags/server
 * COMPLETELY (it supplies `onFlagChange`), and a module can only be mocked one way per file — so
 * it structurally cannot observe this failure. The partial mock has to live in a separate file.
 *
 * ⚠ HOW THIS GUARD REPORTS: if the regression returns, this file does NOT fail an assertion — it
 * fails to COLLECT, contributing zero tests. A red here that names no assertion IS the signal.
 *
 * ⚠ WHY IT ASSERTS ONLY IMPORT-SAFETY, and must not be "strengthened" to call the readers:
 * `txnTimeoutsConfig()` / `adminPoolStatementTimeoutMs()` arm the live-refresh wiring on first
 * call, which legitimately DOES access `onFlagChange`. A test that wants the readers must supply a
 * complete mock — that is a correct requirement, not a gap. The property the 96 files actually
 * need is exactly the one asserted here: importing the module must touch no flags/server binding.
 */
import { describe, it, expect, vi } from 'vitest';

// DELIBERATELY PARTIAL — no `onFlagChange`. This is the shape 96 real test files use today.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async () => false,
}));
vi.mock('./flag-distinct-id', () => ({ systemDistinctId: () => 'system' }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: async () => undefined,
  writeOperatorState: async () => {},
}));

// The import itself is the assertion under test: reaching the next line proves module evaluation
// completed without reading a flags/server binding that the mock above does not define.
import { TXN_TIMEOUTS_DEFAULTS, refreshTxnTimeoutsConfig } from './txn-timeouts-config';

describe('txn-timeouts-config — importable under a PARTIAL flags/server mock (EI-19416650993725684)', () => {
  it('evaluates its module body without touching the omitted onFlagChange binding', () => {
    // Reaching this line at all is the guard. The assertion confirms we imported the real module
    // (a stubbed-out module would not carry the baked 5s/5s floor) rather than a hollow object.
    expect(TXN_TIMEOUTS_DEFAULTS).toEqual({ lockTimeoutMs: 5000, statementTimeoutMs: 5000 });
  });

  it('refreshes against a partial mock — the refresh path reads getFlag only', async () => {
    // refreshTxnTimeoutsConfig is the one live path a partially-mocked consumer can still exercise:
    // it reads getFlag (which the mock supplies) and must not reach for onFlagChange.
    await expect(refreshTxnTimeoutsConfig()).resolves.toBeUndefined();
  });
});
