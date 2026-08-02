// @vitest-environment jsdom
/**
 * TasksRunningPill render + guard coverage (WI-6844).
 *
 * The third header pill, added when the task manager moved out of the left rail's
 * middle pane. What is worth pinning is its SELF-HIDING contract and the fact that
 * it does NOT run a kernel scan: it is mounted on every tab, so a stray
 * `live: true` here would put a cgroup walk behind every page of the operator.
 *
 * Mocks mirror HivesRunningPill.test — the sync query, nuqs and the lazy panel are
 * stubbed so this isolates the pill's own guards. TooltipProvider is required
 * because the shared <Popover> composes a Radix Tooltip (see that file's note; a
 * missing provider is a green-checkpoint deploy blocker, not a test-only detail).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';

const H = vi.hoisted(() => ({
  payload: null as unknown,
  lastArgs: undefined as unknown,
}));

vi.mock('@papercusp/sync', async () => ({
  // WI-6948: this component loads its panel via lazyWithRetry, re-exported from this
  // package — the mock must supply it or the component throws at module init.
  lazyWithRetry: (await import('react')).lazy,
  useSyncQuery: (opts: { args?: unknown }) => {
    H.lastArgs = opts.args;
    return { data: H.payload == null ? undefined : [H.payload] };
  },
}));

const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: () => [nuqs.open, nuqs.set],
  parseAsBoolean: { withDefault: () => ({}) },
}));

// The panel carries the scan and its own sync read — stub it to a marker so this
// file only asserts that the popover mounts it.
vi.mock('./TasksRosterPanel', () => ({
  default: () => <div data-testid="tasks-roster-panel">panel</div>,
}));

import TasksRunningPill, { countActive } from './TasksRunningPill';

const Pill = () => (
  <TooltipProvider>
    <TasksRunningPill />
  </TooltipProvider>
);

const payload = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  summary: { total: 12, byState: { running: 9, starting: 3, exited: 40 }, byClass: {} },
  ...over,
});

beforeEach(() => {
  H.payload = payload();
  H.lastArgs = undefined;
  nuqs.open = false;
  nuqs.set = vi.fn();
});
afterEach(() => cleanup());

describe('countActive', () => {
  it('counts running + starting, and nothing else', () => {
    // `exited` is the bulk of the ledger (884 rows on this box, 560 of them exited)
    // — counting it would make the pill read "884 tasks" on an idle machine.
    expect(countActive({ running: 9, starting: 3, exited: 500, stranded: 200 })).toBe(12);
  });

  it('is 0 for an empty or absent byState', () => {
    expect(countActive({})).toBe(0);
    expect(countActive(undefined)).toBe(0);
  });
});

describe('<TasksRunningPill>', () => {
  it('renders nothing while the inventory has not loaded', () => {
    H.payload = null;
    const { container } = render(<Pill />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the kill-switch is pulled', () => {
    // The flag SURVIVED graduation precisely so it can be flipped off; when it is,
    // the strip must grow no empty chrome.
    H.payload = payload({ enabled: false });
    render(<Pill />);
    expect(screen.queryByTestId('tasks-running-pill')).toBeNull();
  });

  it('renders nothing when nothing is active', () => {
    H.payload = payload({ summary: { total: 40, byState: { exited: 40 }, byClass: {} } });
    render(<Pill />);
    expect(screen.queryByTestId('tasks-running-pill')).toBeNull();
  });

  it('shows the active count, not the ledger total', () => {
    render(<Pill />);
    // total is 12 and active is 12 here by coincidence of the fixture; assert the
    // rendered text so a swap to summary.total is still caught by the case below.
    expect(screen.getByTestId('tasks-running-pill').textContent).toContain('12 tasks');
  });

  it('distinguishes the active count from the ledger total', () => {
    H.payload = payload({ summary: { total: 884, byState: { running: 3, exited: 881 }, byClass: {} } });
    render(<Pill />);
    const text = screen.getByTestId('tasks-running-pill').textContent ?? '';
    expect(text).toContain('3 tasks');
    expect(text).not.toContain('884');
  });

  it('singularises one task', () => {
    H.payload = payload({ summary: { total: 1, byState: { running: 1 }, byClass: {} } });
    render(<Pill />);
    expect(screen.getByTestId('tasks-running-pill').textContent).toContain('1 task');
  });

  // The load-bearing one. This pill mounts on every tab; the `live` arm walks the
  // cgroup tree. Asking for it here would put a kernel scan behind every page.
  it('does NOT request the live scan — that belongs to the panel', () => {
    render(<Pill />);
    expect(H.lastArgs).toEqual({});
  });
});
