/**
 * Unit tests for estimateBenchLaunch — the pre-launch cost/wall estimate the
 * benchmark launch form shows. Pure logic over knownTaskSets(); that loader does
 * fs IO (readJsonl) so it is mocked here, making the test deterministic + IO-free
 * and isolating estimate's own branches (cap clamp, set lookup/fallback, rounding,
 * wave math).
 *
 * Run: cd packages/operator-core && npx vitest run lib/external-bench/estimate.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./task-sets', () => ({
  knownTaskSets: () => [
    { id: '11-task-pilot', label: 'Pilot', count: 11 },
    { id: 'stratified-30', label: 'Stratified 30', count: 30 },
    { id: 'no-count', label: 'Not provisioned', count: null },
  ],
}));

import { estimateBenchLaunch } from './estimate';

const PER_TASK_USD = 3.5;
const PER_TASK_WALL_MIN = 18;

describe('estimateBenchLaunch', () => {
  it('uses the known task-set count for cost + wave math', () => {
    const e = estimateBenchLaunch({ taskSetId: 'stratified-30', cap: 5 });
    expect(e.taskSetId).toBe('stratified-30');
    expect(e.taskCount).toBe(30);
    expect(e.cap).toBe(5);
    expect(e.perTaskUsd).toBe(PER_TASK_USD);
    expect(e.estCostUsd).toBe(Math.round(30 * PER_TASK_USD * 100) / 100); // 105
    // waves = ceil(30/5) = 6 → 6 * 18
    expect(e.estWallMin).toBe(6 * PER_TASK_WALL_MIN);
    expect(e.basis).toContain('m3 real-Queen');
  });

  it('defaults taskSetId to 11-task-pilot and cap to 5 when omitted', () => {
    const e = estimateBenchLaunch({});
    expect(e.taskSetId).toBe('11-task-pilot');
    expect(e.taskCount).toBe(11);
    expect(e.cap).toBe(5);
    expect(e.estCostUsd).toBe(38.5); // 11 * 3.5
    expect(e.estWallMin).toBe(Math.ceil(11 / 5) * PER_TASK_WALL_MIN); // 3 * 18 = 54
  });

  it('falls back to 731 for the not-yet-provisioned swe-bench-pro-full set', () => {
    const e = estimateBenchLaunch({ taskSetId: 'swe-bench-pro-full' });
    expect(e.taskCount).toBe(731);
  });

  it('falls back to 11 for an unknown task-set id', () => {
    expect(estimateBenchLaunch({ taskSetId: 'does-not-exist' }).taskCount).toBe(11);
  });

  it('falls back to 11 when a known set carries a null count', () => {
    // set is found, but set.count === null → ?? triggers → non-full id → 11
    expect(estimateBenchLaunch({ taskSetId: 'no-count' }).taskCount).toBe(11);
  });

  it('clamps the cap: 0/NaN → 5 (default), negative → floor of 1', () => {
    expect(estimateBenchLaunch({ cap: 0 }).cap).toBe(5); // 0 || 5 → 5
    expect(estimateBenchLaunch({ cap: Number.NaN }).cap).toBe(5); // NaN || 5 → 5
    expect(estimateBenchLaunch({ cap: -3 }).cap).toBe(1); // (-3 || 5) = -3 → max(1, -3) = 1
  });

  it('rounds the cost to whole cents', () => {
    const e = estimateBenchLaunch({ taskSetId: '11-task-pilot' });
    expect(Number.isInteger(Math.round(e.estCostUsd * 100))).toBe(true);
    expect(e.estCostUsd).toBe(38.5);
  });

  it('cap of 1 yields one wave per task', () => {
    const e = estimateBenchLaunch({ taskSetId: 'stratified-30', cap: 1 });
    expect(e.estWallMin).toBe(30 * PER_TASK_WALL_MIN);
  });
});
