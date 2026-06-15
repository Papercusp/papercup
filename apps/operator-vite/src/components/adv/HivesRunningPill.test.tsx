// @vitest-environment jsdom
/**
 * HivesRunningPill render + interaction coverage (hive-control-surface).
 *
 * The always-visible header pill: hidden when the HIVE_CONTROL flag is off or no
 * local hive is registered; otherwise a "N hives running" toggle whose `is-running`
 * class reflects the started count, and clicking it flips the nuqs ?hivesCtl param
 * to expand the inline LocalHivesControl popover. The flag client, the
 * `hive.controlState` sync query, and the child control are all mocked so this
 * isolates the pill's guards + toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  flagOn: true,
  rows: [] as Array<{ slug: string; started: boolean }>,
}));

vi.mock('@papercusp/flags/client', () => ({ useFlag: () => H.flagOn }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: H.rows }) }));
// The child control boots its own sync/runtime — stub to a marker so we only
// assert that the popover mounts it.
vi.mock('../left-sidebar/LocalHivesControl', () => ({
  default: () => <div data-testid="local-hives-control">control</div>,
}));

// nuqs ?hivesCtl boolean — a per-test store with a spy setter.
const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
vi.mock('nuqs', () => ({
  useQueryState: () => [nuqs.open, nuqs.set],
  parseAsBoolean: { withDefault: () => ({}) },
}));

import HivesRunningPill from './HivesRunningPill';

beforeEach(() => {
  H.flagOn = true;
  H.rows = [{ slug: 'a', started: true }, { slug: 'b', started: false }];
  nuqs.open = false;
  nuqs.set = vi.fn();
});
afterEach(() => cleanup());

describe('<HivesRunningPill>', () => {
  it('renders nothing when the HIVE_CONTROL flag is off', () => {
    H.flagOn = false;
    const { container } = render(<HivesRunningPill />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('hives-running-pill')).toBeNull();
  });

  it('renders nothing when no local hive is registered', () => {
    H.rows = [];
    const { container } = render(<HivesRunningPill />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the pluralized running label and the is-running class when ≥1 started', () => {
    render(<HivesRunningPill />);
    const pill = screen.getByTestId('hives-running-pill');
    expect(pill.textContent).toContain('1 hive running');
    expect(pill.className).toContain('is-running');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
  });

  it('drops the is-running class when nothing is started (and pluralizes 0)', () => {
    H.rows = [{ slug: 'a', started: false }, { slug: 'b', started: false }];
    render(<HivesRunningPill />);
    const pill = screen.getByTestId('hives-running-pill');
    expect(pill.textContent).toContain('0 hives running');
    expect(pill.className).not.toContain('is-running');
  });

  it('clicking the pill flips the ?hivesCtl param (open the popover)', () => {
    render(<HivesRunningPill />);
    fireEvent.click(screen.getByTestId('hives-running-pill'));
    expect(nuqs.set).toHaveBeenCalledWith(true);
  });

  it('clicking again (when open) flips it back to false', () => {
    nuqs.open = true;
    render(<HivesRunningPill />);
    expect(screen.getByTestId('hives-running-pill').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('hives-running-pill'));
    expect(nuqs.set).toHaveBeenCalledWith(false);
  });

  it('mounts the LocalHivesControl popover only while open', () => {
    const { rerender } = render(<HivesRunningPill />);
    expect(screen.queryByTestId('hives-running-pop')).toBeNull();
    expect(screen.queryByTestId('local-hives-control')).toBeNull();
    nuqs.open = true;
    rerender(<HivesRunningPill />);
    expect(screen.getByTestId('hives-running-pop')).toBeTruthy();
    expect(screen.getByTestId('local-hives-control')).toBeTruthy();
  });
});
