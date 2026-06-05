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
});
