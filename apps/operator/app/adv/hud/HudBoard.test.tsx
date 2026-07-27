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
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import HudBoard from './HudBoard';
import {
  ALL_FLEETS,
  ALL_PLANS,
  buildHudBoard,
  type HudRosterEntry,
} from './hud-board-model';

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/* The plan filter (P-004) is a real Combobox, so this suite renders the real
   one — only its Radix Popover is stubbed, exactly as Combobox's own suite does
   it: in anchor mode the anchor is inline and the panel exists only while open,
   which is all the component depends on. Stubbing the Combobox itself instead
   would leave the wiring this file exists to prove (options in, sentinel out)
   untested on both sides. */
vi.mock('@/app/harness/Popover', () => ({
  Popover: ({
    open,
    anchor,
    children,
  }: {
    open: boolean;
    anchor: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {anchor}
      {open ? <div data-testid="popover-panel">{children}</div> : null}
    </div>
  ),
}));

// cmdk scrolls its active item into view; jsdom has no such method.
beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});
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
    harnessSlug: null,
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
    selectedPlans: [],
    onSelectPlan: vi.fn(),
    focusColumn: null,
    onFocusColumn: vi.fn(),
    suOnly: true,
    onToggleSuOnly: vi.fn(),
    onOpenSession: vi.fn(),
    loading: false,
    error: null,
    tab: 'sessions',
    onSelectTab: vi.fn(),
    // A stub, not the real NewSessionLauncher — this file is presentation-only
    // and the slot exists precisely so it stays testable without mocking a
    // live plan-list fetch (see HudBoardProps.headerAction).
    headerAction: <span data-testid="launcher" />,
    ...over,
  };
  return { props, ...render(<HudBoard {...props} />) };
}

// Sessions transcript search (owner ask 2026-07-26). The board stays
// presentation-only: HudView runs the search against every session's full turn
// history and passes an already-narrowed `board`, so these pin the CONTRACT
// (input shows, edits report up, empty copy tells the truth) — not the search.
describe('HudBoard — sessions transcript search', () => {
  it('renders no search box when the sessions tab has no handler wired', () => {
    const { queryByTestId } = renderBoard([entry()]);
    expect(queryByTestId('hud-session-search')).toBeNull();
  });

  it('renders the search box and reports every keystroke up', async () => {
    const onSessionQuery = vi.fn();
    const { getByTestId } = renderBoard([entry()], { onSessionQuery, sessionQuery: '' });
    const box = getByTestId('hud-session-search');
    fireEvent.change(box, { target: { value: 'gym gate' } });
    expect(onSessionQuery).toHaveBeenCalledWith('gym gate');
  });

  // The regression that matters: a search matching nothing must not render as an
  // empty roster, or you go hunting for a launch bug instead of clearing the box.
  it('an empty board under an ACTIVE search says the search matched nothing, not that no sessions run', () => {
    const { getByText, queryByText } = renderBoard([], {
      onSessionQuery: vi.fn(),
      sessionQuery: 'nothing matches this',
      searchActive: true,
    });
    expect(getByText(/No session transcript matched that search/i)).toBeTruthy();
    expect(queryByText(/No su sessions are running/i)).toBeNull();
  });

  it('an empty board with NO search still says no sessions are running', () => {
    const { getByText, queryByText } = renderBoard([], { onSessionQuery: vi.fn(), searchActive: false });
    expect(getByText(/No su sessions are running/i)).toBeTruthy();
    expect(queryByText(/No session transcript matched/i)).toBeNull();
  });
});

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
    // Asserted via the ACCESSIBLE NAME, not the 👑 glyph: the label is the part
    // that must not regress (swapping text for an emoji is exactly how a role
    // silently drops out of the accessible tree).
    expect(within(card).getByLabelText('Fleet leader')).toBeTruthy();
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

  // Regression: the "all fleets" chip must raise the SHARED sentinel, because
  // HudView clears the filter on `slug === ALL_FLEETS` and treats anything else
  // as a real fleet slug to toggle ON. While HudBoard spelled the literal out
  // itself the two drifted — its leading space had been corrupted to a raw NUL
  // byte, so the comparison never matched and clicking "all fleets" ADDED a
  // junk slug to the filter, emptying the board instead of showing everything.
  // Asserting against the imported constant (not a re-typed literal) is the
  // point: a copy that drifts again cannot pass this test.
  it('raises the shared ALL_FLEETS sentinel from the all-fleets chip', () => {
    const { props } = renderBoard([
      entry({ ownerId: 'su-11111111-a', fleetSlug: 'atlas', fleetRole: 'leader' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: /all fleets/ }));
    expect(props.onToggleFleet).toHaveBeenCalledWith(ALL_FLEETS);
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

  // The chip cap exists so a busy card can't grow unbounded, but a mode is the
  // agent's standing POSTURE — the thing that decides whether your silence is
  // fine. An agent stacking modes used to spend the whole 4-chip budget on them
  // (hiding its claims), and a heavily-chipped agent could lose the mode instead.
  // Modes render always; only the derived stats compete for the cap.
  it('never truncates mode chips, and caps only the stats around them', () => {
    renderBoard([
      entry({
        modes: [
          { mode: 'auto', ownerDirected: true },
          { mode: 'ideate' },
          { mode: 'grade' },
        ],
        claims: [{ status: 'done' }, { status: 'wip' }],
        contextTokens: 180_000,
        compactionLimit: 200_000,
        loopArmed: true,
        pendingWakes: 2,
        wakeMode: 'manual',
      }),
    ]);
    const chips = [...document.querySelectorAll('.hud__chip')].map((c) => c.textContent);
    for (const label of ['AUTO', 'IDEATE', 'GRADE']) {
      expect(chips, label).toContain(label);
    }
    const modeChips = document.querySelectorAll('.hud__chip--mode');
    expect(modeChips.length).toBe(3);
    // Owner-armed carries its own marker class; agent-set does not.
    expect(document.querySelectorAll('.hud__chip--mode-owner').length).toBe(1);
  });

  it('labels a mode chip from the registry, so cold-auto is not rendered as an id', () => {
    renderBoard([entry({ modes: [{ mode: 'cold-auto' }] })]);
    const chip = [...document.querySelectorAll('.hud__chip--mode')][0];
    expect(chip?.textContent).toBe('COLD AUTO');
  });

  /* ── tabs (hud-session-launcher-and-board-tabs-2026-07-26 P-009) ────────── */

  it('renders the three board tabs and reports a selection', () => {
    const { props } = renderBoard([entry()]);
    for (const label of ['Sessions', 'Plans', 'Work items']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('tab', { name: 'Sessions' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    expect(props.onSelectTab).toHaveBeenCalledWith('plans');
  });

  it('swaps the session controls for the entity view on a non-session tab', () => {
    // The su-only toggle, the count chips and the fleet strip are session
    // CONCEPTS — a plan has no fleet — so they must not survive the switch.
    renderBoard([entry({ fleetSlug: 'atlas', fleetRole: 'leader' })], {
      tab: 'plans',
      entityView: <div data-testid="entity-view" />,
    });
    expect(screen.getByTestId('entity-view')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'su sessions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /all fleets/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Working' })).toBeNull();
    // …but the launcher does, because it is a HUD-wide control.
    expect(screen.getByTestId('launcher')).toBeTruthy();
  });

  // Regression guard for the P-009 move: hud-consolidation P-002 made
  // unattributed asks visible on this board as the gate for retiring the
  // sidebar Inbox. They now render on the Work items tab, so the sessions
  // board must still SAY they exist — a count nobody can reach is the same
  // failure as no count at all.
  it('keeps a reachable pointer to unattributed asks after moving them off this board', () => {
    const board = buildHudBoard(
      [entry()],
      [
        {
          ownerAgentId: null,
          title: 'Ratify the dark flag',
          occurredAt: iso(60_000),
          id: 'ask-1',
          kind: 'dark-flag-ratification',
          itemRef: null,
          planSlug: null,
          harnessSlug: null,
        },
      ],
      { nowMs: NOW },
    );
    const props = { board, tab: 'sessions' as const };
    const { props: p } = renderBoard([], props);
    const nudge = screen.getByRole('button', { name: /unattributed ask/ });
    fireEvent.click(nudge);
    expect(p.onSelectTab).toHaveBeenCalledWith('items');
    expect(screen.getByRole('status').textContent).toContain('Work items tab');
  });

  /* ── plan filter (P-004) ───────────────────────────────────────────────── */

  const planned = () => [
    entry({ ownerId: 'su-1111', currentPlanSlug: 'alpha-plan', pendingWakes: 1 }),
    entry({ ownerId: 'su-2222', currentPlanSlug: 'alpha-plan' }),
    entry({ ownerId: 'su-3333', currentPlanSlug: 'beta-plan' }),
    entry({ ownerId: 'su-4444', currentPlanSlug: null }),
  ];

  const openPlanFilter = () => {
    const box = screen.getByRole('combobox', { name: 'Filter by plan' });
    fireEvent.focus(box);
    return box;
  };

  it('offers every plan in view, with its own count and health note', () => {
    renderBoard(planned());
    openPlanFilter();
    const panel = within(screen.getByTestId('popover-panel'));
    // The clear row leads and counts the WHOLE in-view set, not the filtered one.
    expect(panel.getByText('All plans')).toBeTruthy();
    expect(panel.getByText('4 sessions in view')).toBeTruthy();
    // Per-plan counts, and the same one-line warning a fleet chip carries.
    expect(panel.getByText('2 sessions · 1 needs you')).toBeTruthy();
    // beta-plan and the unbound group, one session each — singular, not "1 sessions".
    expect(panel.getAllByText('1 session').length).toBe(2);
    // Sessions bound to no plan are a filterable group, not an omission.
    expect(panel.getByText('no plan')).toBeTruthy();
  });

  it('reports a chosen plan, the no-plan group, and the shared ALL_PLANS sentinel', () => {
    const { props } = renderBoard(planned());

    openPlanFilter();
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('beta-plan'));
    expect(props.onSelectPlan).toHaveBeenCalledWith('beta-plan');

    openPlanFilter();
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('no plan'));
    // `null`, not the token: the token is a URL/DOM encoding, and the callback
    // speaks the model's language (same contract as onToggleFleet's solo group).
    expect(props.onSelectPlan).toHaveBeenCalledWith(null);

    openPlanFilter();
    fireEvent.click(within(screen.getByTestId('popover-panel')).getByText('All plans'));
    // Asserted against the imported constant, never a re-typed literal — the
    // ALL_FLEETS drift this file already guards against is a whitespace-ish
    // sentinel that a copy can corrupt invisibly.
    expect(props.onSelectPlan).toHaveBeenCalledWith(ALL_PLANS);
  });

  // The control is the ONE place the filter's state is visible once the panel
  // is shut. If it kept showing its placeholder while a plan was selected, the
  // board would silently be a subset with nothing on screen saying so.
  it('shows the active plan in the closed box, and the placeholder when clear', () => {
    const filtered = renderBoard(planned(), { selectedPlans: ['alpha-plan'] });
    const box = screen.getByRole('combobox', { name: 'Filter by plan' }) as HTMLInputElement;
    expect(box.value).toBe('alpha-plan');
    filtered.unmount();
    cleanup();

    renderBoard(planned());
    const clear = screen.getByRole('combobox', { name: 'Filter by plan' }) as HTMLInputElement;
    expect(clear.value).toBe('');
    expect(clear.getAttribute('placeholder')).toBe('All plans');
  });

  /* Placement regression guard. The picker first shipped at the end of the
     fleet strip, which is `nowrap` + `overflow-x: auto` — so on the narrow HUD
     rail, with 14 fleet chips ahead of it, it was off screen entirely (caught
     live 2026-07-26, not by any unit test). It belongs in .hud__top, which
     wraps. Asserting the CONTAINER is the cheap standing guard for that. */
  it('puts the plan filter in the wrapping controls row, not the scrolling fleet strip', () => {
    renderBoard([entry({ currentPlanSlug: 'alpha-plan', fleetSlug: 'atlas', fleetRole: 'leader' })]);
    const top = document.querySelector('.hud__top');
    expect(top).toBeTruthy();
    expect(within(top as HTMLElement).getByRole('combobox', { name: 'Filter by plan' })).toBeTruthy();
    const strip = document.querySelector('.hud__fleets') as HTMLElement;
    expect(within(strip).queryByRole('combobox', { name: 'Filter by plan' })).toBeNull();
  });

  it('hides the plan filter on a non-session tab', () => {
    renderBoard(planned(), { tab: 'plans', entityView: <div data-testid="entity-view" /> });
    expect(screen.queryByRole('combobox', { name: 'Filter by plan' })).toBeNull();
  });
});

/**
 * Header LAYOUT — the two owner asks of 2026-07-27, pinned as document ORDER.
 *
 * Both are position asks, and position is exactly what a screenshot cannot assert
 * durably. The first ask had already been made "a few times": earlier passes kept
 * rearranging controls INSIDE the launcher while it stayed on the tab strip's row,
 * when the row being referred to was the TAB STRIP's. Encoding the reading as an
 * assertion is what stops a third misread.
 */
describe('header layout (owner asks 2026-07-27)', () => {
  it('puts the launcher on its OWN row, AFTER the tab strip — not inside it', () => {
    const { container } = renderBoard([entry()]);
    const tabs = container.querySelector('.hud__tabs');
    const launchRow = container.querySelector('.hud__launchrow');
    expect(tabs, '.hud__tabs must exist').toBeTruthy();
    expect(launchRow, 'the launcher needs a row of its own below the tabs').toBeTruthy();

    // Not nested inside the tab strip — that is the layout being corrected.
    expect(tabs!.contains(launchRow!)).toBe(false);
    // DOCUMENT_POSITION_FOLLOWING === the launcher row comes AFTER the tabs.
    expect(tabs!.compareDocumentPosition(launchRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and it is the launcher that lives there.
    expect(within(launchRow as HTMLElement).getByTestId('launcher')).toBeTruthy();
  });

  it('keeps the launch button out of the tablist (a11y: a tablist holds only tabs)', () => {
    const { container } = renderBoard([entry()]);
    const tablist = container.querySelector('[role="tablist"]')!;
    expect(within(tablist as HTMLElement).queryByTestId('launcher')).toBeNull();
  });

  it('orders the plan filter FIRST in the filter row, ahead of the all-agents toggle', () => {
    const { container } = renderBoard(planned());
    const planFilter = container.querySelector('.hud__planfilter');
    const toggle = screen.getByRole('button', { name: /su sessions|all agents/ });
    expect(planFilter, 'the plan filter must render on the sessions tab').toBeTruthy();
    // The ask: "move the plan filter as the first filter before all agents".
    expect(planFilter!.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no longer right-aligns the plan filter behind a flex spacer', () => {
    // The spacer existed only to push the filter to the far right; leaving it in
    // would re-open the gap the owner asked to close.
    const { container } = renderBoard(planned());
    expect(container.querySelector('.hud__top .hud__spacer')).toBeNull();
  });
});
