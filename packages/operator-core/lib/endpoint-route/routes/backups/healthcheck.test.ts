import { describe, expect, it } from 'vitest';
import { classifyBackupHealth } from './healthcheck';

const NOW = Date.parse('2026-08-30T01:00:00.000Z');

describe('classifyBackupHealth', () => {
  it('reports a degraded dump as failing even when no complete snapshot exists', () => {
    expect(classifyBackupHealth(true, {
      lastSnapshotAt: null,
      lastFailureAt: '2026-08-30T00:59:00.000Z',
    }, NOW)).toEqual({ state: 'failing', ageSeconds: null });
  });

  it('reports never_run only when neither a complete snapshot nor a failure exists', () => {
    expect(classifyBackupHealth(true, {
      lastSnapshotAt: null,
      lastFailureAt: null,
    }, NOW)).toEqual({ state: 'never_run', ageSeconds: null });
  });

  it('uses the newest complete snapshot for staleness', () => {
    expect(classifyBackupHealth(true, {
      lastSnapshotAt: '2026-08-29T00:00:00.000Z',
      lastFailureAt: null,
    }, NOW)).toEqual({ state: 'stale', ageSeconds: 25 * 60 * 60 });
  });

  it('lets a newer failed/degraded row override an older complete snapshot', () => {
    expect(classifyBackupHealth(true, {
      lastSnapshotAt: '2026-08-30T00:30:00.000Z',
      lastFailureAt: '2026-08-30T00:45:00.000Z',
    }, NOW)).toEqual({ state: 'failing', ageSeconds: 30 * 60 });
  });

  it('keeps a recent complete snapshot healthy when an older failure is present', () => {
    expect(classifyBackupHealth(true, {
      lastSnapshotAt: '2026-08-30T00:45:00.000Z',
      lastFailureAt: '2026-08-30T00:30:00.000Z',
    }, NOW)).toEqual({ state: 'ok', ageSeconds: 15 * 60 });
  });

  it('reports disabled before inspecting snapshot history', () => {
    expect(classifyBackupHealth(false, {
      lastSnapshotAt: null,
      lastFailureAt: '2026-08-30T00:59:00.000Z',
    }, NOW)).toEqual({ state: 'disabled', ageSeconds: null });
  });
});
