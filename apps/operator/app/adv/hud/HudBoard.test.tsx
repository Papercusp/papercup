// @vitest-environment jsdom
/**
 * HudBoard render coverage (adv-hud-fleet-board-2026-07-25 P-005).
 *
 * The classification itself is covered exhaustively in hud-board-model.test.ts;
 * this suite pins the things only a DOM can prove:
 *   - every column renders, including empty ones (an empty Blocked column is
 *     the good outcome and must still be visible to say so);
 *   - a card is a BUTTON that opens its session — the board has no drag
 *     affordance, because columns are derived and moving a card would be a lie
 *     (plan D-001);
 *   - the fleet accent arrives as data (--hud-fleet), not a hardcoded palette;
 *   - the column focus + fleet toggles report the right values back;
 *   - loading / error / empty states are distinguishable rather than all
 *     collapsing to a blank grid.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import HudBoard from './HudBoard';
import { buildHudBoard, type HudRosterEntry } from './hud-board-model';

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

const NOW = Date.parse('2026-07-25T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function entry(over: Partial<HudRosterEntry> = {}): HudRosterEntry {
  return {
    ownerId: 'su-aaaaaaaa-1111-2222-3333-444444444444',
    label: 'su · su-aaaaa',
    source: 'omp-hook-session',
    intent: 'greening the release gate',
    currentFiles: [],
    liveness: 'live',
    stale: false,
    lastActiveAt: iso(5_000),
    intentDeclaredAt: iso(60_000),
    loopArmed: false,
    modes: [],
    pidAlive: true,
    claims: [],
    declaredUnclaimed: false,
    currentPlanSlug: null,
    agentPaneKind: 'su',
    role: 'su',
    agent: 'claude',
    advSessionId: 1,
    windowId: null,
    wakeMode: 'auto',
    pendingWakes: 0,
    fleetSlug: null,
    fleetColor: null,
    fleetRole: null,
    contextTokens: null,
    compactionLimit: null,
    openAwait: null,
    thinking: false,
    ...over,
  };
}

function renderBoard(
  roster: HudRosterEntry[],
  over: Partial<React.ComponentProps<typeof HudBoard>> = {},
) {
  const props: React.ComponentProps<typeof HudBoard> = {
    board: buildHudBoard(roster, [], { nowMs: NOW }),
    selectedFleets: [],
    onToggleFleet: vi.fn(),
    focusColumn: null,
    onFocusColumn: vi.fn(),
    suOnly: true,
    onToggleSuOnly: vi.fn(),
    onOpenSession: vi.fn(),
    loading: false,
    error: null,
    ...over,
  };
  return { props, ...render(<HudBoard {...props} />) };
}

describe('HudBoard', () => {
  it('renders all five state columns', () => {
    renderBoard([entry()]);
    for (const label of ['Needs you', 'Working', 'Blocked', 'Stalled', 'Parked · done']) {
      expect(screen.getByRole('region', { name: label })).toBeTruthy();
    }
  });

  it('shows the all-clear line in an empty column rather than a blank box', () => {
    // An empty Blocked column is the GOOD outcome — the board has to say so,
    // otherwise "nothing is blocked" is indistinguishable from "not loaded".
    renderBoard([entry()]);
    const blocked = screen.getByRole('region', { name: 'Blocked' });
    expect(within(blocked).getByText('Nothing is waiting on a gate')).toBeTruthy();
  });

  it('places a gated session in Blocked and names the gate on its card', () => {
    renderBoard([
      entry({
        openAwait: {
          eventKey: 'fleet:release-gate:suite-green',
          note: null,
          sinceIso: iso(41 * 60_000),
          expiresIso: null,
        },
      }),
    ]);
    const blocked = screen.getByRole('region', { name: 'Blocked' });
    expect(within(blocked).getByText(/fleet:release-gate:suite-green/)).toBeTruthy();
    expect(within(blocked).getByText('41m')).toBeTruthy();
  });

  it('renders each session as a button that opens it — and offers no drag handle', () => {
    const { props } = renderBoard([entry()]);
    const card = screen.getByRole('button', { name: /su-aaaaaaaa/ });
    // Columns are DERIVED, so a draggable card would promise something the
    // board cannot deliver (plan D-001).
    expect(card.getAttribute('draggable')).toBeNull();
    fireEvent.click(card);
    expect(props.onOpenSession).toHaveBeenCalledWith('su-aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('takes the fleet accent from roster DATA, not a hardcoded palette', () => {
    renderBoard([entry({ fleetSlug: 'atlas', fleetColor: '#86efac' })]);
    const card = screen.getByRole('button', { name: /su-aaaaaaaa/ });
    expect(card.getAttribute('style')).toContain('#86efac');
  });

  it('marks the fleet leader on the card', () => {
    renderBoard([entry({ fleetSlug: 'atlas', fleetRole: 'leader' })]);
    const card = screen.getByRole('button', { name: /su-aaaaaaaa/ });
    expect(within(card).getByText('LEAD')).toBeTruthy();
  });

  it('reports the clicked column back for focus, and toggles it off when re-clicked', () => {
    const { props, rerender } = renderBoard([entry()]);
    fireEvent.click(screen.getByRole('button', { name: /needs you/i }));
    expect(props.onFocusColumn).toHaveBeenCalledWith('needs-you');

    rerender(<HudBoard {...props} focusColumn="needs-you" />);
    fireEvent.click(screen.getByRole('button', { name: /needs you/i }));
    expect(props.onFocusColumn).toHaveBeenLastCalledWith(null);
  });

  it('collapses to a single column when one is focused', () => {
    renderBoard([entry()], { focusColumn: 'working' });
    expect(screen.getByRole('region', { name: 'Working' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Blocked' })).toBeNull();
  });

  it('renders a fleet chip carrying its count and its warning', () => {
    const { props } = renderBoard([
      entry({ ownerId: 'su-11111111-a', fleetSlug: 'atlas', fleetRole: 'member' }),
    ]);
    const chip = screen.getByRole('button', { name: /atlas/ });
    // A member-only fleet has nobody to reclaim claims or open its gates.
    expect(chip.textContent).toContain('no leader');
    fireEvent.click(chip);
    expect(props.onToggleFleet).toHaveBeenCalledWith('atlas');
  });

  it('distinguishes loading, error and genuinely-empty', () => {
    const empty = buildHudBoard([], [], { nowMs: NOW });

    const { unmount } = renderBoard([], { board: empty, loading: true });
    expect(screen.getByText(/Reading the session roster/)).toBeTruthy();
    unmount();
    cleanup();

    const e2 = renderBoard([], { board: empty, error: 'pg down' });
    expect(screen.getByText(/Could not read the session roster: pg down/)).toBeTruthy();
    e2.unmount();
    cleanup();

    renderBoard([], { board: empty });
    // The empty state names BOTH launch paths, because the owner's requirement
    // is precisely that either one shows up here.
    expect(screen.getByText(/psu command, or from the New session button/)).toBeTruthy();
  });

  it('announces the needs-you count for screen readers', () => {
    renderBoard([entry({ pendingWakes: 1 })]);
    expect(screen.getByRole('status').textContent).toContain('1 session waiting on you');
  });

  it('offers the all-agents escape hatch and reports the toggle', () => {
    const { props } = renderBoard([entry()]);
    const toggle = screen.getByRole('button', { name: 'su sessions' });
    fireEvent.click(toggle);
    expect(props.onToggleSuOnly).toHaveBeenCalled();
  });
});
