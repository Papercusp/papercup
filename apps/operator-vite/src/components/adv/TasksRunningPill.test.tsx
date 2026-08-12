// @vitest-environment jsdom
/**
 * TasksRunningPill render + guard coverage (WI-6844).
 *
 * The third header pill, added when the task manager moved out of the left rail's
 * middle pane.
 *
 * The contract INVERTED on 2026-08-02 after the owner caught the pill reading
 * "3 tasks" on a box running 131 agents. It used to count LEDGER rows and
 * deliberately skip the live scan (mounted on every tab, the scan looked too
 * expensive). That made it cheap and wrong by two orders of magnitude. It now
 * reports the live scan's process total, affordable because the scan is memoised
 * server-side and shared with the panel; the ledger is only a fallback for when the
 * scan is unavailable. The tests below pin the NEW direction, and the old
 * "does NOT request the live scan" case is inverted rather than deleted so the
 * reversal is legible to whoever reads this next.
 *
 * Mocks mirror PotsRunningPill.test — the sync query, nuqs and the lazy panel are
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
  onSyncBusEvent: () => () => {},
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

// The panel carries its own read — stub it to a marker so this file only asserts
// that the popover mounts it.
vi.mock('./TasksRosterPanel', () => ({
  default: () => <div data-testid="tasks-roster-panel">panel</div>,
}));

import TasksRunningPill, { countActive, countProcesses } from './TasksRunningPill';

const Pill = () => (
  <TooltipProvider>
    <TasksRunningPill />
  </TooltipProvider>
);

const payload = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  summary: { total: 12, byState: { running: 9, starting: 3, exited: 40 }, byClass: {} },
  live: { scan: { processes: 431 } },
  ...over,
});

beforeEach(() => {
  H.payload = payload();
  H.lastArgs = undefined;
  nuqs.open = false;
  nuqs.set = vi.fn();
});
afterEach(() => cleanup());

describe('countProcesses', () => {
  it('reports the live scan total, NOT the ledger', () => {
    // The owner-reported defect in one assertion: a ledger showing 3 running rows
    // on a box where the scan sees 431 processes must report 431.
    expect(countProcesses({
      enabled: true,
      summary: { total: 884, byState: { running: 3, exited: 881 }, byClass: {} },
      live: { scan: { processes: 431 } },
    })).toBe(431);
  });

  it('falls back to the ledger only when the scan is unavailable', () => {
    const summary = { total: 12, byState: { running: 9, starting: 3 }, byClass: {} };
    expect(countProcesses({ enabled: true, summary, live: null })).toBe(12);
    expect(countProcesses({ enabled: true, summary, live: { scan: {} } })).toBe(12);
    // A degraded scan reporting 0 is not evidence of an empty box — prefer the
    // ledger's honest undercount over a confident zero.
    expect(countProcesses({ enabled: true, summary, live: { scan: { processes: 0 } } })).toBe(12);
  });

  it('is 0 with no payload at all', () => {
    expect(countProcesses(undefined)).toBe(0);
  });
});

describe('countActive (the ledger fallback)', () => {
  it('counts running + starting, and nothing else', () => {
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

  it('renders nothing when nothing at all is running', () => {
    H.payload = payload({
      summary: { total: 40, byState: { exited: 40 }, byClass: {} },
      live: { scan: { processes: 0 } },
    });
    render(<Pill />);
    expect(screen.queryByTestId('tasks-running-pill')).toBeNull();
  });

  // THE REGRESSION TEST for what the owner caught. A ledger with 3 running rows and
  // a scan seeing 431 must render 431 — never 3.
  it('shows the scanned process count, not the ledger count', () => {
    H.payload = payload({
      summary: { total: 884, byState: { running: 3, exited: 881 }, byClass: {} },
      live: { scan: { processes: 431 } },
    });
    render(<Pill />);
    const text = screen.getByTestId('tasks-running-pill').textContent ?? '';
    expect(text).toContain('431 processes');
    expect(text).not.toContain('3 process');
    expect(text).not.toContain('884');
  });

  it('says "process" not "task" — the two are different populations', () => {
    render(<Pill />);
    expect(screen.getByTestId('tasks-running-pill').textContent).toContain('processes');
  });

  it('singularises one process', () => {
    H.payload = payload({ live: { scan: { processes: 1 } } });
    render(<Pill />);
    expect(screen.getByTestId('tasks-running-pill').textContent).toContain('1 process');
  });

  // INVERTED 2026-08-02. This previously asserted `{}` — that the pill must NOT ask
  // for the scan — which is precisely what made it report the ledger. It now must
  // ask, with countsOnly so the 4000-row process table does not ride onto every tab.
  it('requests the live scan, counts-only', () => {
    render(<Pill />);
    expect(H.lastArgs).toEqual({ live: true, countsOnly: true });
  });
});
