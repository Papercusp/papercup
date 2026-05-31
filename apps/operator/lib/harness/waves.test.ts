import { describe, it, expect } from 'vitest';
import {
  isWaveDrained,
  isWaveBlocked,
  waveCounts,
  nextWaveToPromote,
  type WaveFeature,
  type PromoteWaveLike,
} from './waves';

const f = (wave: string | null, status: string, attempts = 0): WaveFeature => ({ wave, status, attempts });

describe('isWaveDrained', () => {
  it('true when every in-wave feature is terminal (passed/deprecated)', () => {
    expect(isWaveDrained([f('t1', 'passed'), f('t1', 'deprecated')], 't1')).toBe(true);
  });
  it('false when any in-wave feature is non-terminal', () => {
    expect(isWaveDrained([f('t1', 'passed'), f('t1', 'failing')], 't1')).toBe(false);
    expect(isWaveDrained([f('t1', 'passed'), f('t1', 'in_progress')], 't1')).toBe(false);
    expect(isWaveDrained([f('t1', 'todo')], 't1')).toBe(false);
  });
  it('an empty wave is trivially drained', () => {
    expect(isWaveDrained([], 't1')).toBe(true);
    expect(isWaveDrained([f('t2', 'failing')], 't1')).toBe(true); // other waves ignored
  });
  it('only considers features in the named wave', () => {
    expect(isWaveDrained([f('t1', 'passed'), f('t2', 'failing')], 't1')).toBe(true);
  });
});

describe('isWaveBlocked', () => {
  it('blocked when failing and nothing in progress (not_stuck)', () => {
    expect(isWaveBlocked([f('t1', 'failing'), f('t1', 'passed')], 't1')).toBe(true);
  });
  it('NOT blocked when failing but work is in progress', () => {
    expect(isWaveBlocked([f('t1', 'failing'), f('t1', 'in_progress')], 't1')).toBe(false);
    expect(isWaveBlocked([f('t1', 'failing'), f('t1', 'validating')], 't1')).toBe(false);
  });
  it('NOT blocked when nothing is failing', () => {
    expect(isWaveBlocked([f('t1', 'todo'), f('t1', 'passed')], 't1')).toBe(false);
  });
  it('blocked when a non-terminal feature hits the attempt threshold', () => {
    expect(isWaveBlocked([f('t1', 'validating', 3)], 't1', 3)).toBe(true); // even though in-progress
    expect(isWaveBlocked([f('t1', 'todo', 5)], 't1', 3)).toBe(true);
  });
  it('a terminal feature past the threshold does NOT block', () => {
    expect(isWaveBlocked([f('t1', 'passed', 9)], 't1', 3)).toBe(false);
  });
});

describe('waveCounts', () => {
  it('counts per status within the wave', () => {
    const c = waveCounts(
      [f('t1', 'passed'), f('t1', 'failing'), f('t1', 'validating'), f('t1', 'blocked'), f('t2', 'passed')],
      't1',
    );
    expect(c).toEqual({ total: 4, passed: 1, failing: 1, inProgress: 1, blocked: 1, deprecated: 0 });
  });
});

describe('nextWaveToPromote', () => {
  const waves: PromoteWaveLike[] = [{ id: 't1' }, { id: 't2', blocked_by: 't1' }, { id: 't3', blocked_by: 't2' }];
  it('null cursor → first wave', () => {
    expect(nextWaveToPromote(waves, null)?.id).toBe('t1');
  });
  it('cursor → the next wave', () => {
    expect(nextWaveToPromote(waves, 't1')?.id).toBe('t2');
    expect(nextWaveToPromote(waves, 't2')?.id).toBe('t3');
  });
  it('cursor at the last wave → null', () => {
    expect(nextWaveToPromote(waves, 't3')).toBeNull();
  });
  it('unknown cursor → null (do not guess)', () => {
    expect(nextWaveToPromote(waves, 'ghost')).toBeNull();
  });
  it('no waves → null', () => {
    expect(nextWaveToPromote([], null)).toBeNull();
  });
});
