import { describe, test, expect } from 'vitest';
import {
  selectFeaturesToDispatch,
  resolveDispatchHarnesses,
  shouldScheduleDispatch,
} from './orchestrator-dispatcher';

const f = (id: string, status: string) => ({ id, status });

describe('resolveDispatchHarnesses — all-harnesses default + allowlist override (P-006)', () => {
  const all = ['papercup', 'sheets', 'restart'];

  test('"*" → every harness in the workspace (the default-on-for-all rollout)', () => {
    expect(resolveDispatchHarnesses('*', all)).toEqual(all);
  });

  test('whitespace around "*" still means all', () => {
    expect(resolveDispatchHarnesses('  *  ', all)).toEqual(all);
  });

  test('empty / unset → ALL (P-009 flip: DBOS is the default orchestrator for every harness)', () => {
    expect(resolveDispatchHarnesses('', all)).toEqual(all);
    expect(resolveDispatchHarnesses(undefined, all)).toEqual(all);
  });

  test('explicit comma list is an override (scoped testing) — not all', () => {
    expect(resolveDispatchHarnesses('sheets', all)).toEqual(['sheets']);
    expect(resolveDispatchHarnesses('sheets, restart', all)).toEqual(['sheets', 'restart']);
  });

  test('"none" / "off" → disabled (explicit opt-out, e.g. the shared dev box)', () => {
    expect(resolveDispatchHarnesses('none', all)).toEqual([]);
    expect(resolveDispatchHarnesses('off', all)).toEqual([]);
    expect(resolveDispatchHarnesses('  none  ', all)).toEqual([]);
  });

  test('trims + drops blanks in an explicit list', () => {
    expect(resolveDispatchHarnesses(' sheets , , restart ,', all)).toEqual(['sheets', 'restart']);
  });
});

describe('shouldScheduleDispatch — when to arm the 30s tick (P-009: schedule by default)', () => {
  test('"*" → schedule (all-harnesses mode)', () => {
    expect(shouldScheduleDispatch('*')).toBe(true);
  });
  test('explicit allowlist → schedule', () => {
    expect(shouldScheduleDispatch('sheets,restart')).toBe(true);
  });
  test('empty / unset → schedule (default-all)', () => {
    expect(shouldScheduleDispatch('')).toBe(true);
    expect(shouldScheduleDispatch(undefined)).toBe(true);
  });
  test('"none" / "off" → do NOT schedule (explicit opt-out)', () => {
    expect(shouldScheduleDispatch('none')).toBe(false);
    expect(shouldScheduleDispatch('off')).toBe(false);
  });
});

describe('selectFeaturesToDispatch', () => {
  test('empty eligible → nothing', () => {
    expect(selectFeaturesToDispatch([], 0, 4)).toEqual([]);
  });

  test('picks only needs-work statuses (todo/failing + pending/failed aliases)', () => {
    const eligible = [
      f('F-1', 'todo'),
      f('F-2', 'in_progress'),
      f('F-3', 'failing'),
      f('F-4', 'passed'),
      f('F-5', 'blocked'),
      f('F-6', 'pending'),
      f('F-7', 'failed'),
      f('F-8', 'deprecated'),
    ];
    expect(selectFeaturesToDispatch(eligible, 0, 10)).toEqual(['F-1', 'F-3', 'F-6', 'F-7']);
  });

  test('bounded by free slots (cap - liveCount)', () => {
    const eligible = [f('F-1', 'pending'), f('F-2', 'pending'), f('F-3', 'failed')];
    expect(selectFeaturesToDispatch(eligible, 0, 2)).toEqual(['F-1', 'F-2']); // 2 free slots
    expect(selectFeaturesToDispatch(eligible, 1, 2)).toEqual(['F-1']); // 1 free slot
  });

  test('cap already reached → nothing started', () => {
    const eligible = [f('F-1', 'pending')];
    expect(selectFeaturesToDispatch(eligible, 4, 4)).toEqual([]);
    expect(selectFeaturesToDispatch(eligible, 5, 4)).toEqual([]); // over cap
  });

  test('preserves order, slices to slots', () => {
    const eligible = [f('F-9', 'failed'), f('F-1', 'pending'), f('F-5', 'pending')];
    expect(selectFeaturesToDispatch(eligible, 0, 2)).toEqual(['F-9', 'F-1']);
  });

  test('over cost cap → dispatch nothing, regardless of eligible work (P-004)', () => {
    const eligible = [f('F-1', 'todo'), f('F-2', 'failing')];
    expect(selectFeaturesToDispatch(eligible, 0, 4, /* overCostCap */ true)).toEqual([]);
  });

  test('under cost cap → unchanged selection', () => {
    const eligible = [f('F-1', 'todo')];
    expect(selectFeaturesToDispatch(eligible, 0, 4, /* overCostCap */ false)).toEqual(['F-1']);
  });
});
