import { expect, it, vi } from 'vitest';
import { boundedStage, miningFailureReason } from './pipeline';
import { fingerprintSqlIntent } from '../bash-substitution/sql-intent-fingerprint';
it('R18-UNKNOWN', async () => {
  expect(miningFailureReason(Object.assign(new Error('SELECT secret FROM private'), { code: '23505' }))).toBe('database-23505');
  expect(miningFailureReason(new Error('SELECT secret FROM private'))).toBe('dependency-error');
  vi.useFakeTimers();
  try {
    const pending = expect(boundedStage(() => new Promise<never>(() => {}), 30)).rejects.toThrow('sql_mining_time_budget');
    await vi.advanceTimersByTimeAsync(30); await pending;
  } finally { vi.useRealTimers(); }
});
it('R20-ISOLATION', async () => {
  let recorded = false;
  const source = async () => { recorded = true; return { status: 'ok' }; };
  await expect(source()).resolves.toEqual({ status: 'ok' }); expect(recorded).toBe(true);
  // The separate background instrument is allowed to fail; it has no source callback to poison.
  await expect(boundedStage(async () => { throw new Error('mining unavailable'); }, 50)).rejects.toThrow();
  expect(recorded).toBe(true);
});
it('R25-PASSIVE', () => {
  const scope = { workspaceId: 'test', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(71) };
  expect(fingerprintSqlIntent("SELECT set_config('mining_must_not_run','executed',false)", scope).status).toBe('unknown');
  expect(fingerprintSqlIntent('DROP TABLE jobs', scope).status).toBe('unknown');
});
