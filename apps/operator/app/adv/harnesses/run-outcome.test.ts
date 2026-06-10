// Unit tests for the P-023 run-outcome chip derivation (pure logic, no React).
import { describe, expect, it } from 'vitest';
import { runOutcome } from './run-outcome';

describe('runOutcome', () => {
  it('maps a done spawn to a done chip', () => {
    expect(runOutcome({ spawnStatus: 'done', exitCode: 0 })).toEqual({ kind: 'done', label: 'done' });
  });

  it('maps a failed spawn to a failed chip carrying the error detail', () => {
    expect(runOutcome({ spawnStatus: 'failed', exitCode: 1, errorMessage: 'boom' })).toEqual({
      kind: 'failed',
      label: 'failed (exit 1)',
      detail: 'boom',
    });
  });

  it('omits the exit suffix when the failed exit code is 0/null', () => {
    expect(runOutcome({ spawnStatus: 'failed', exitCode: null })).toEqual({
      kind: 'failed',
      label: 'failed',
      detail: undefined,
    });
    expect(runOutcome({ spawnStatus: 'failed', exitCode: 0, errorMessage: ' ' })).toEqual({
      kind: 'failed',
      label: 'failed',
      detail: undefined,
    });
  });

  it('maps cancelled and reaped', () => {
    expect(runOutcome({ spawnStatus: 'cancelled' })).toEqual({ kind: 'cancelled', label: 'cancelled', detail: undefined });
    expect(runOutcome({ spawnStatus: 'reaped' })).toEqual({ kind: 'muted', label: 'reaped', detail: undefined });
  });

  it('maps running/restarting spawn statuses to a running chip', () => {
    expect(runOutcome({ spawnStatus: 'running' })).toEqual({ kind: 'running', label: 'running' });
    expect(runOutcome({ spawnStatus: 'restarting' })).toEqual({ kind: 'running', label: 'restarting' });
  });

  it('legacy rows (no spawn): running flag → running chip, finished → NO chip (unknown outcome is not invented)', () => {
    expect(runOutcome({ running: true })).toEqual({ kind: 'running', label: 'running' });
    expect(runOutcome({ running: false })).toBeNull();
    expect(runOutcome({})).toBeNull();
  });

  it('treats an unknown future status with running=false as no chip rather than guessing', () => {
    expect(runOutcome({ spawnStatus: 'something-new', running: false })).toBeNull();
  });
});
