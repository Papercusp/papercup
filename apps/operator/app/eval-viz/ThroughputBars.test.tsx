// @vitest-environment jsdom
//
// ThroughputBars (L2 fleet throughput) — speedup resolution + render coverage
// (impartial-benchmark-suite P-030 / BRIEF 10). Bar length = speedup vs the
// serial floor; null speedup is derived from wall-clock (slowest ≈ 1×).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThroughputBars, computeThroughputBars, type ThroughputArm } from './ThroughputBars';

afterEach(cleanup);

const ARMS: ThroughputArm[] = [
  { arm: 'hive', tasksPerHour: 12, costPerTask: 0.8, wallClockMs: 3_600_000, speedupVsSerial: 3 },
  { arm: 'queen-ablated', tasksPerHour: 6, costPerTask: 0.9, wallClockMs: 7_200_000, speedupVsSerial: 1.5 },
  { arm: 'native-serial', tasksPerHour: 4, costPerTask: 1.0, wallClockMs: 10_800_000, speedupVsSerial: 1 },
];

describe('computeThroughputBars', () => {
  it('uses the provided speedupVsSerial when present', () => {
    const bars = computeThroughputBars(ARMS);
    expect(bars.map((b) => b.speedup)).toEqual([3, 1.5, 1]);
    expect(bars.every((b) => !b.derived)).toBe(true);
  });

  it('derives speedup from wall-clock when null (slowest ≈ 1×)', () => {
    const derived = computeThroughputBars([
      { arm: 'hive', tasksPerHour: 12, costPerTask: 0.8, wallClockMs: 2_000_000, speedupVsSerial: null },
      { arm: 'native-serial', tasksPerHour: 4, costPerTask: 1, wallClockMs: 8_000_000, speedupVsSerial: null },
    ]);
    // slowest (native, 8M ms) → 1×; hive (2M ms) → 4×.
    expect(derived.find((b) => b.arm === 'native-serial')!.speedup).toBeCloseTo(1, 6);
    expect(derived.find((b) => b.arm === 'hive')!.speedup).toBeCloseTo(4, 6);
    expect(derived.every((b) => b.derived)).toBe(true);
  });

  it('falls back to 1× when there is no wall-clock or speedup', () => {
    const bars = computeThroughputBars([{ arm: 'hive', tasksPerHour: 0, costPerTask: 0, wallClockMs: 0, speedupVsSerial: null }]);
    expect(bars[0].speedup).toBe(1);
  });
});

describe('<ThroughputBars />', () => {
  it('renders one bar per arm, highlights the hive arm, and a 1× reference', () => {
    const { container } = render(<ThroughputBars arms={ARMS} />);
    expect(container.querySelectorAll('[data-testid="tput-bar"]')).toHaveLength(3);
    expect(container.querySelectorAll('.pc-tput__bar--hi')).toHaveLength(1); // hive
    expect(container.querySelector('.pc-tput__ref')).not.toBeNull();
    const titles = [...container.querySelectorAll('rect title')].map((t) => t.textContent ?? '');
    expect(titles.some((t) => t.includes('Hive') && t.includes('3×') && t.includes('tasks/hr'))).toBe(true);
  });

  it('renders an empty state when there are no arms', () => {
    const { getByTestId } = render(<ThroughputBars arms={[]} emptyHint="nothing" />);
    expect(getByTestId('tput-empty').textContent).toBe('nothing');
  });
});
