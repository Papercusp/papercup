// @vitest-environment jsdom
/**
 * ThrottleSection.test — the 👑 Queen tab throttle knobs
 * (queen-steering-panel-2026-06-15 P-007).
 *
 * Pins: the pure resolution helpers (effective floor/ceiling, active count) and
 * that each knob writes the right value through its callback — cadence presets +
 * number commit, max-bees commit, the bee tier-cap select, the idle toggles, and
 * the auto-scale-out toggle.
 */
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({
  tiers: [
    { name: 'fast', spec: 'haiku' },
    { name: 'std', spec: 'sonnet' },
    { name: 'max', spec: 'opus:xhigh' },
  ] as unknown[],
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: H.tiers, loading: false, error: null }),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: string; disabled?: boolean }>;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
// Lexicon resolver mocked to ECHO its key (t('contributor') → 'contributor') —
// isolates the bee→Cup labels from the THE_HIVE flag hook (restore-pot-lexicon P-005).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import ThrottleSection, {
  effectiveCadence,
  effectiveMax,
  idleEnabled,
  throttleActiveCount,
} from './ThrottleSection';

const Wrap = ({ children }: { children: ReactNode }) => <NuqsTestingAdapter>{children}</NuqsTestingAdapter>;

type Props = Parameters<typeof ThrottleSection>[0];
function makeProps(over: Partial<Props> = {}): Props {
  return {
    cadenceFloorSec: null,
    maxBees: null,
    tierCeilings: null,
    idleActivities: null,
    autoScaleOut: null,
    defaults: { cadenceFloorSec: 60, maxBees: 8, breakerThreshold: 3 },
    busy: false,
    onSetCadenceFloor: vi.fn(),
    onSetMaxBees: vi.fn(),
    onSetBeeTierCap: vi.fn(),
    onToggleIdle: vi.fn(),
    onSetAutoScaleOut: vi.fn(),
    ...over,
  };
}

afterEach(cleanup);

describe('ThrottleSection pure helpers', () => {
  it('effectiveCadence is a FLOOR — MAX(system, override)', () => {
    expect(effectiveCadence(null, 60)).toBe(60);
    expect(effectiveCadence(120, 60)).toBe(120);
    expect(effectiveCadence(30, 60)).toBe(60); // owner can only RAISE the floor
  });
  it('effectiveMax is a CEILING — MIN(system, override)', () => {
    expect(effectiveMax(null, 8)).toBe(8);
    expect(effectiveMax(4, 8)).toBe(4);
    expect(effectiveMax(20, 8)).toBe(8);
    expect(effectiveMax(4, null)).toBe(4); // system unknown ⇒ the override alone
  });
  it('idleEnabled defaults ON; only explicit false suppresses', () => {
    expect(idleEnabled(null, 'gym')).toBe(true);
    expect(idleEnabled({}, 'scout')).toBe(true);
    expect(idleEnabled({ gym: false }, 'gym')).toBe(false);
    expect(idleEnabled({ gym: false }, 'scout')).toBe(true);
  });
  it('throttleActiveCount counts knobs away from default (each idle suppression counts)', () => {
    expect(throttleActiveCount({ cadenceFloorSec: null, maxBees: null, beeTier: null, idleActivities: null, autoScaleOut: null })).toBe(0);
    // cadence + max + tier + autoScaleOut(false) + 2 suppressed idle = 6
    expect(
      throttleActiveCount({ cadenceFloorSec: 120, maxBees: 4, beeTier: 'std', idleActivities: { gym: false, scout: false }, autoScaleOut: false }),
    ).toBe(6);
    // autoScaleOut === true (explicit-on, not the disable) does NOT count
    expect(throttleActiveCount({ cadenceFloorSec: null, maxBees: null, beeTier: null, idleActivities: { gym: true }, autoScaleOut: true })).toBe(0);
  });
});

describe('ThrottleSection rendering + writes', () => {
  it('renders all knobs with the system defaults in the hints', () => {
    render(<ThrottleSection {...makeProps()} />, { wrapper: Wrap });
    expect(screen.getByText('Throttle')).toBeTruthy();
    expect(screen.getByText('defaults')).toBeTruthy();
    expect(screen.getByLabelText('Wake cadence floor (seconds)')).toBeTruthy();
    expect(screen.getByLabelText('Max concurrent contributor')).toBeTruthy();
    expect(screen.getByLabelText('Cap contributor at model tier')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Gym idle activity' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Auto scale-out the account pool' })).toBeTruthy();
  });

  it('a cadence preset chip writes that floor', () => {
    const props = makeProps();
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('button', { name: '120s' }));
    expect(props.onSetCadenceFloor).toHaveBeenCalledWith(120);
  });

  it('typing a max-bees value and blurring commits it (floored, ≥1)', () => {
    const props = makeProps();
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    const input = screen.getByLabelText('Max concurrent contributor');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(props.onSetMaxBees).toHaveBeenCalledWith(4);
  });

  it('clearing the cadence input commits null (clear override)', () => {
    const props = makeProps({ cadenceFloorSec: 300 });
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    const input = screen.getByLabelText('Wake cadence floor (seconds)');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(props.onSetCadenceFloor).toHaveBeenCalledWith(null);
  });

  it('the tier-cap select writes the chosen tier name (a ceiling on the bee role)', () => {
    const props = makeProps();
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    fireEvent.change(screen.getByLabelText('Cap contributor at model tier'), { target: { value: 'std' } });
    expect(props.onSetBeeTierCap).toHaveBeenCalledWith('std');
  });

  it('toggling an idle activity off calls onToggleIdle(kind,false)', () => {
    const props = makeProps();
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    // 'scout' label pack-routes via t('scout'); the identity useLexicon mock
    // returns the key, so the aria-label is 'scout idle activity' (the live
    // classic/Pot label is "Blender").
    fireEvent.click(screen.getByRole('checkbox', { name: 'scout idle activity' }));
    expect(props.onToggleIdle).toHaveBeenCalledWith('scout', false);
  });

  it('unchecking auto scale-out calls onSetAutoScaleOut(false)', () => {
    const props = makeProps();
    render(<ThrottleSection {...props} />, { wrapper: Wrap });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto scale-out the account pool' }));
    expect(props.onSetAutoScaleOut).toHaveBeenCalledWith(false);
  });

  it('shows the active count when knobs are set', () => {
    render(<ThrottleSection {...makeProps({ cadenceFloorSec: 120, maxBees: 4 })} />, { wrapper: Wrap });
    expect(screen.getByText('2 active')).toBeTruthy();
  });
});
