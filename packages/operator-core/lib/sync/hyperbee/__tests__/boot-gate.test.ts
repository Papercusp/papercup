/**
 * boot-gate — P-031a tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  isReadyForProjection,
  markSqlMigrationsComplete,
  markRuntimeEnsureComplete,
  awaitEnsurePaths,
  BootGateTimeoutError,
  _resetFlagsForTests,
  isMigrationsAppliedForRequestGate,
  markMigrationsAppliedForRequestGate,
  awaitMigrationsAppliedForRequestGate,
} from '../boot-gate';

afterEach(() => _resetFlagsForTests());

describe('boot-gate', () => {
  it('is not ready before either flag is set', () => {
    expect(isReadyForProjection()).toBe(false);
  });

  it('is not ready with only sql flag', () => {
    markSqlMigrationsComplete();
    expect(isReadyForProjection()).toBe(false);
  });

  it('is not ready with only runtime flag', () => {
    markRuntimeEnsureComplete();
    expect(isReadyForProjection()).toBe(false);
  });

  it('is ready once both flags are set', () => {
    markSqlMigrationsComplete();
    markRuntimeEnsureComplete();
    expect(isReadyForProjection()).toBe(true);
  });

  it('awaitEnsurePaths resolves promptly once both flags arrive', async () => {
    setTimeout(() => {
      markSqlMigrationsComplete();
      markRuntimeEnsureComplete();
    }, 50);
    await awaitEnsurePaths({ timeoutMs: 1000, pollMs: 10 });
    expect(isReadyForProjection()).toBe(true);
  });

  it('awaitEnsurePaths throws BootGateTimeoutError after the deadline', async () => {
    await expect(
      awaitEnsurePaths({ timeoutMs: 100, pollMs: 20 }),
    ).rejects.toThrow(BootGateTimeoutError);
  });

  it('timeout error carries the unset flags', async () => {
    markSqlMigrationsComplete();
    try {
      await awaitEnsurePaths({ timeoutMs: 100, pollMs: 20 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BootGateTimeoutError);
      expect((e as BootGateTimeoutError).flags).toEqual({
        sql_migrations_complete: true,
      });
    }
  });

  // WI-5441/WI-5764: request-serving migrations gate — deliberately independent
  // of sql_migrations_complete/runtime_ensure_complete above (see the field doc
  // on request_gate_migrations_applied in boot-gate.ts).
  describe('request-serving migrations gate (WI-5441/WI-5764)', () => {
    it('is not applied before the flag is marked', () => {
      expect(isMigrationsAppliedForRequestGate()).toBe(false);
    });

    it('is applied once marked, independent of the other two flags', () => {
      markMigrationsAppliedForRequestGate();
      expect(isMigrationsAppliedForRequestGate()).toBe(true);
      expect(isReadyForProjection()).toBe(false);
    });

    it('awaitMigrationsAppliedForRequestGate resolves promptly once marked', async () => {
      setTimeout(() => markMigrationsAppliedForRequestGate(), 50);
      await awaitMigrationsAppliedForRequestGate({ timeoutMs: 1000, pollMs: 10 });
      expect(isMigrationsAppliedForRequestGate()).toBe(true);
    });

    it('awaitMigrationsAppliedForRequestGate throws BootGateTimeoutError after the deadline', async () => {
      await expect(
        awaitMigrationsAppliedForRequestGate({ timeoutMs: 100, pollMs: 20 }),
      ).rejects.toThrow(BootGateTimeoutError);
    });
  });
});
