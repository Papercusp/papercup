// @vitest-environment jsdom
/**
 * HudEntityColumns render coverage
 * (hud-session-launcher-and-board-tabs-2026-07-26 P-009).
 *
 * The column derivation is covered exhaustively in hud-entity-board.test.ts;
 * this suite pins the things only a DOM can prove — and above all the `notice`
 * contract, which exists because of a real defect found by driving the built
 * UI rather than by reading it:
 *
 *   The Work items tab gates its read on a RESOLVED HARNESS. With none (a
 *   deep-link to /adv?tab=hud with no `slug`, or a fresh profile with no
 *   localStorage), the work-items query never fires — but the unattributed
 *   asks folded into needs-you still put `board.total` above zero, so the
 *   `emptyLabel` branch never ran. Verified live in an isolated Tauri instance
 *   on 2026-07-26: 60 cards rendered, ZERO of them work items, counts reading
 *   "146 needs you", and `document.body.innerText.includes("Pick a harness")`
 *   === false. The board asserted a number it had not loaded.
 *
 * So the invariant under test is specifically that the notice survives the
 * board having cards — an assertion that it renders on an EMPTY board would
 * have passed against the buggy code and proved nothing.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import HudEntityColumns from './HudEntityColumns';
import {
  buildGoalBoard,
  buildPlanBoard,
  buildWorkItemBoard,
  goalsTruncationNotice,
  type HudPlanInput,
  type HudWorkItemInput,
} from './hud-entity-board';
import type { HudAsk } from './hud-board-model';

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/* The sort picker is a real Combobox; only its Radix Popover is stubbed, the
   same way HudBoard.test.tsx (and Combobox's own suite) do it. */
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

afterEach(cleanup);

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

function item(over: Partial<HudWorkItemInput> = {}): HudWorkItemInput {
  return {
    id: 'WI-1',
    kind: 'change',
    title: 'A real work item',
    state: 'open',
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function ask(over: Partial<HudAsk> = {}): HudAsk {
  return {
    ownerAgentId: null,
    title: 'Something needs a human decision',
    occurredAt: new Date(NOW - 120_000).toISOString(),
    id: 'a1',
    kind: 'work-item-needs-human',
    itemRef: null,
    planSlug: null,
    harnessSlug: null,
    ...over,
  };
}

function renderCols(
  over: Partial<React.ComponentProps<typeof HudEntityColumns>> = {},
  build: { items?: HudWorkItemInput[]; asks?: HudAsk[] } = {},
) {
  const props: React.ComponentProps<typeof HudEntityColumns> = {
    board: buildWorkItemBoard(build.items ?? [], build.asks ?? [], { nowMs: NOW }),
    focusColumn: null,
    onFocusColumn: vi.fn(),
    query: '',
    onQuery: vi.fn(),
    loading: false,
    error: null,
    emptyLabel: 'Pick a harness to see its work items.',
    noun: 'work items',
    ...over,
  };
  return { props, ...render(<HudEntityColumns {...props} />) };
}

describe('HudEntityColumns notice', () => {
  it('renders the caveat even when the board HAS cards — the whole point', () => {
    // Exactly the broken shape: asks present, no work items loaded.
    renderCols(
      { notice: 'No harness is selected, so no work items could be loaded.' },
      { items: [], asks: [ask()] },
    );

    // The cards are there…
    expect(screen.getByText('Something needs a human decision')).toBeTruthy();
    // …and the board still says what it could not load.
    expect(screen.getByRole('status').textContent).toContain('No harness is selected');
  });

  it('says nothing when there is nothing to caveat', () => {
    renderCols({ notice: null }, { items: [item()], asks: [] });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not swallow the empty-state when the board is genuinely empty', () => {
    // Both must be able to show at once: "nothing here" AND "and here is why".
    renderCols({ notice: 'No harness is selected.' }, { items: [], asks: [] });
    expect(screen.getByRole('status').textContent).toContain('No harness is selected');
    expect(screen.getByText('Pick a harness to see its work items.')).toBeTruthy();
  });

  it('keeps the caveat visible while an error is being reported', () => {
    // An error explains the failure; the notice explains the SCOPE. Losing the
    // scope line here would leave "Could not read work items: boom" looking
    // like the whole story when the read was never attempted for a harness.
    renderCols({ notice: 'No harness is selected.', error: 'boom' }, { items: [], asks: [] });
    expect(screen.getByRole('status').textContent).toContain('No harness is selected');
    expect(screen.getByText(/Could not read work items: boom/)).toBeTruthy();
  });
});

describe('HudEntityColumns rendering', () => {
  it('renders all five columns, including empty ones', () => {
    renderCols({}, { items: [item()], asks: [] });
    for (const label of ['Needs you', 'Working', 'Blocked', 'Ready', 'Done']) {
      expect(screen.getByRole('region', { name: label })).toBeTruthy();
    }
  });

  it('reports a column focus back and toggles it off when re-clicked', () => {
    const onFocusColumn = vi.fn();
    const { rerender, props } = renderCols({ onFocusColumn }, { items: [item()], asks: [] });

    fireEvent.click(screen.getByRole('button', { name: /ready/i }));
    expect(onFocusColumn).toHaveBeenLastCalledWith('ready');

    rerender(<HudEntityColumns {...props} focusColumn="ready" />);
    fireEvent.click(screen.getByRole('button', { name: /ready/i }));
    expect(onFocusColumn).toHaveBeenLastCalledWith(null);
  });

  it('collapses to the single focused column', () => {
    renderCols({ focusColumn: 'ready' }, { items: [item()], asks: [] });
    expect(screen.getByRole('region', { name: 'Ready' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
  });

  it('reports typing in the filter box', () => {
    const onQuery = vi.fn();
    renderCols({ onQuery }, { items: [item()], asks: [] });
    fireEvent.change(screen.getByLabelText('Filter work items'), {
      target: { value: 'WI-1' },
    });
    expect(onQuery).toHaveBeenCalledWith('WI-1');
  });

  it('distinguishes a filtered-empty board from a genuinely empty one', () => {
    renderCols({ query: 'zzz' }, { items: [], asks: [] });
    expect(screen.getByText(/No work items match/)).toBeTruthy();
    expect(screen.queryByText('Pick a harness to see its work items.')).toBeNull();
  });

  it('announces a truncated column rather than quietly showing fewer cards', () => {
    const items = Array.from({ length: 5 }, (_, i) => item({ id: `WI-${i}`, state: 'open' }));
    renderCols(
      { board: buildWorkItemBoard(items, [], { nowMs: NOW, maxPerColumn: 2 }) },
      {},
    );
    expect(screen.getByText(/\+3 more/)).toBeTruthy();
  });

  /* hud-open-destinations-and-true-counts-2026-07-27 P-002 — the owner asked
     for the left sidebar's behaviour: clicking a row opens it in a popup. The
     seam was deliberately left unwired when these tabs shipped, so this is the
     first time these cards are activatable at all. */
  describe('card activation (P-002)', () => {
    it('renders cards as inert divs when no destination is supplied', () => {
      renderCols({}, { items: [item({ id: 'WI-1', state: 'open' })], asks: [] });
      // The card label is `${ref} — ${title}`; no button should carry it.
      expect(screen.queryByRole('button', { name: /^WI-1 — / })).toBeNull();
    });

    it('renders cards as real buttons and fires onOpenCard with the card', () => {
      const onOpenCard = vi.fn();
      renderCols({ onOpenCard }, { items: [item({ id: 'WI-1', state: 'open' })], asks: [] });
      const card = screen.getByRole('button', { name: /^WI-1 — / });
      fireEvent.click(card);
      expect(onOpenCard).toHaveBeenCalledTimes(1);
      expect(onOpenCard.mock.calls[0][0]).toMatchObject({ id: 'WI-1', ref: 'WI-1' });
    });
  });

  /* WI-6668 — the resilience property, tested at the board level rather than
     only on the primitive (RenderBoundary.test.tsx covers that in isolation).
     WI-6551 shipped precisely because every fixture here was fully populated,
     so no test had ever rendered a MALFORMED row: `actions` was dropped by the
     list feed, dereferenced unguarded, and one bad row blanked the entire tab.
     These deliberately corrupt a row the way a feed actually does. */
  describe('one malformed card cannot blank the board (WI-6668)', () => {
    /** The WI-6551 shape exactly: a field the card dereferences is missing,
     *  because the feed that produced the row does not send it. */
    function boardWithABadCard() {
      const board = buildWorkItemBoard(
        [
          item({ id: 'WI-GOOD-1', state: 'open' }),
          item({ id: 'WI-BAD', state: 'open' }),
          item({ id: 'WI-GOOD-2', state: 'open' }),
        ],
        [],
        { nowMs: NOW },
      );
      const col = board.columns.find((c) => c.cards.length > 0);
      if (!col) throw new Error('fixture built no cards');
      const bad = col.cards.find((c) => c.id === 'WI-BAD');
      if (!bad) throw new Error('fixture lost the row it was going to corrupt');
      // `EntityCard` does `card.badges.slice(...)` — undefined here throws the
      // same TypeError class the owner saw.
      (bad as { badges?: unknown }).badges = undefined;
      return board;
    }

    it('keeps the sibling cards, the column, and the other columns rendered', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderCols({ board: boardWithABadCard() });

        // The siblings in the SAME column survive — the row degraded, not the list.
        expect(screen.getByText(/WI-GOOD-1/)).toBeTruthy();
        expect(screen.getByText(/WI-GOOD-2/)).toBeTruthy();
        // Every column still renders (the tab is alive).
        for (const label of ['Needs you', 'Working', 'Blocked', 'Ready', 'Done']) {
          expect(screen.getByRole('region', { name: label })).toBeTruthy();
        }
        // No column-level fallback fired: the ROW boundary contained it.
        expect(screen.queryByTestId('section-boundary-error')).toBeNull();
      } finally {
        err.mockRestore();
      }
    });

    it('replaces the bad row with a named placeholder instead of dropping it', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderCols({ board: boardWithABadCard() });
        // Visible, not silent: a quietly missing row would make the column's
        // count disagree with the DOM, which is how counts stop being trusted.
        const placeholder = screen.getByTestId('row-boundary-error');
        expect(placeholder.textContent).toContain('WI-BAD');
      } finally {
        err.mockRestore();
      }
    });
  });
});

/**
 * The empty-state gate (goals-tab-improvement-2026-08-09 P-015).
 *
 * `board.total` counts ENTITIES; the columns hold CARDS, and the two can
 * honestly disagree — the Goals board prepends an uncounted "+ Start a goal"
 * action card precisely so an empty board does not report "1 goal". Gated on
 * the COUNT, that card rendered nowhere in the empty-board case it exists for.
 *
 * Both directions are asserted, because a test that only checks the card
 * appears would also pass against a version that simply always renders the
 * columns and never shows an empty state at all.
 */
describe('empty state is gated on CARDS, not on the count', () => {
  const emptyBoard = () => buildWorkItemBoard([], [], { nowMs: NOW });

  it('renders a column card whose board reports total 0', () => {
    const board = emptyBoard();
    const lane = board.columns.find((c) => c.id === 'needs-you')!;
    lane.cards = [
      {
        id: 'goal:start',
        ref: '+',
        title: 'Start a goal',
        column: 'needs-you',
        reason: 'No goals yet',
        context: null,
        badges: [],
        sinceSec: null,
        sortKey: 0,
        open: { kind: 'start-goal' },
      },
    ];
    expect(board.total).toBe(0);

    render(
      <HudEntityColumns
        board={board}
        focusColumn={null}
        onFocusColumn={() => {}}
        query=""
        onQuery={() => {}}
        loading={false}
        error={null}
        emptyLabel="No goals yet."
        noun="goals"
        onOpenCard={() => {}}
      />,
    );
    expect(screen.getByText('Start a goal')).toBeTruthy();
    expect(screen.queryByText('No goals yet.')).toBeNull();
  });

  it('still shows the empty label when there are genuinely no cards', () => {
    render(
      <HudEntityColumns
        board={emptyBoard()}
        focusColumn={null}
        onFocusColumn={() => {}}
        query=""
        onQuery={() => {}}
        loading={false}
        error={null}
        emptyLabel="No goals yet."
        noun="goals"
        onOpenCard={() => {}}
      />,
    );
    expect(screen.getByText('No goals yet.')).toBeTruthy();
  });
});

/**
 * The `renderCardAction` seam (goals-tab-improvement-2026-08-09 P-016).
 *
 * Two claims, and both are the kind that a typecheck and a rendered screenshot
 * BOTH pass while broken:
 *
 *   1. The action is a SIBLING of the card, never a descendant. The card is a
 *      real <button> whenever it has a destination, and a button inside a
 *      button is invalid HTML — browsers reparent it, so the inner click target
 *      becomes unreliable in a way that looks fine until someone clicks it.
 *      The `tagName` assertion below is load-bearing: without it, "not nested"
 *      is also satisfied by a card that stopped being a button, which is the
 *      one case where the nesting never mattered.
 *   2. A board that supplies no action grows NO wrapper — the whole point of a
 *      render prop over a flag. Plans and Work items must render the tree they
 *      rendered before P-016 existed.
 */
describe('HudEntityColumns renderCardAction', () => {
  it('puts the action BESIDE the card, not inside it', () => {
    const { container } = renderCols(
      {
        onOpenCard: vi.fn(),
        renderCardAction: () => (
          <button type="button" data-testid="act">
            Pause
          </button>
        ),
      },
      { items: [item({ id: 'WI-1', title: 'First' })], asks: [] },
    );

    const wrap = container.querySelector('.hud__card-wrap');
    expect(wrap).toBeTruthy();
    const body = wrap!.querySelector('.hud__card');
    const action = screen.getByTestId('act');

    // CONTROL: the card really is a <button>, which is the only reason the
    // nesting claim below has any teeth.
    expect(body!.tagName).toBe('BUTTON');
    expect(body!.contains(action)).toBe(false);
    // …but they are still one unit, so the action positions against the card.
    expect(action.closest('.hud__card-wrap')).toBe(wrap);
  });

  it('grows no wrapper at all for a board that supplies no action', () => {
    const { container } = renderCols(
      { onOpenCard: vi.fn() },
      { items: [item({ id: 'WI-1' })], asks: [] },
    );
    expect(container.querySelector('.hud__card-wrap')).toBeNull();
    // CONTROL: the same board DOES grow one when an action is supplied, so the
    // absence above is the omitted prop and not a missing class name.
    cleanup();
    const withAction = renderCols(
      { onOpenCard: vi.fn(), renderCardAction: () => <span data-testid="act" /> },
      { items: [item({ id: 'WI-1' })], asks: [] },
    );
    expect(withAction.container.querySelector('.hud__card-wrap')).toBeTruthy();
  });

  it('grows no wrapper for a card whose action renders null, while its neighbour keeps one', () => {
    // The shape the Goals board actually needs: the `start-goal` ACTION CARD is
    // not a goal, so it gets no pause button — but every real goal beside it
    // must still get one. A blanket wrapper would put an empty action slot on
    // the action card; a blanket skip would strip it from the real ones.
    const { container } = renderCols(
      {
        onOpenCard: vi.fn(),
        renderCardAction: (card) =>
          card.id === 'WI-1' ? <button type="button" data-testid="act">Pause</button> : null,
      },
      {
        items: [
          item({ id: 'WI-1', title: 'A real goal' }),
          item({ id: 'WI-2', title: 'The action card' }),
        ],
        asks: [],
      },
    );

    expect(container.querySelectorAll('.hud__card').length).toBe(2);
    expect(container.querySelectorAll('.hud__card-wrap').length).toBe(1);
    expect(screen.getAllByTestId('act').length).toBe(1);
  });

  it('hands the whole card to the render prop, not just its id', () => {
    // The host reads the goal's status off the query and keys it by id, so it
    // needs the card — a bare id would force it to re-derive what the board
    // already resolved (the WI-6742 re-derivation bug, one layer up).
    const seen: Array<{ id: string; title: string }> = [];
    renderCols(
      {
        onOpenCard: vi.fn(),
        renderCardAction: (card) => {
          seen.push({ id: card.id, title: card.title });
          return null;
        },
      },
      { items: [item({ id: 'WI-1', title: 'A real goal' })], asks: [] },
    );

    expect(seen).toContainEqual({ id: 'WI-1', title: 'A real goal' });
  });
});

/* ── the goal board's two DOM-only contracts ─────────────────────────────────
   Both exist because the pieces were verified SEPARATELY and the JOIN was not —
   the same shape as this file's founding defect (two correct components, one
   broken join). The pots chip had a unit test for its label and an integration
   test for its SQL, and nothing proving a card actually renders it; the
   truncation notice had a unit test for its sentence and nothing proving it
   reaches the screen. Neither could be observed on live data: every goal in the
   workspace has zero pots, and the cap needs 100+ goals to bind. */
describe('the goal board', () => {
  const goalCols = (goals: Parameters<typeof buildGoalBoard>[0], notice: string | null = null) =>
    render(
      <HudEntityColumns
        board={buildGoalBoard(goals, { nowMs: NOW })}
        focusColumn={null}
        onFocusColumn={vi.fn()}
        query=""
        onQuery={vi.fn()}
        loading={false}
        error={null}
        emptyLabel="No goals yet."
        notice={notice}
        noun="goals"
      />,
    );

  it('renders the pots chip on a card, NAMING the pots (P-007)', () => {
    goalCols([
      {
        id: 'g1',
        title: 'Ship the thing',
        status: 'active',
        potCount: 3,
        pots: [{ harnessSlug: 'alpha' }, { harnessSlug: 'beta' }],
      },
    ]);
    // The point of P-007: not "3 pots" but WHICH.
    expect(document.body.textContent).toContain('alpha, beta +1');
    expect(document.body.textContent).not.toContain('3 pots');
  });

  it('marks a SHARED pot on the card, where D-021 says the reader must see it', () => {
    goalCols([
      {
        id: 'g1',
        title: 'Ship the thing',
        status: 'active',
        potCount: 1,
        pots: [{ harnessSlug: 'alpha', servesGoals: 2 }],
      },
    ]);
    expect(document.body.textContent).toContain('alpha · shared');
  });

  it('shows the truncation notice on a board that HAS cards (EI-20080280064869122)', () => {
    // Asserting it on an EMPTY board would prove nothing — the empty state has
    // its own branch. The defect being guarded is a FULL-looking board that is
    // silently a prefix, so the notice must survive cards being present.
    goalCols(
      [{ id: 'g1', title: 'Ship the thing', status: 'active' }],
      goalsTruncationNotice(100, 214),
    );
    expect(document.body.textContent).toContain('Showing 100 of 214 goals');
    expect(screen.getByText(/Showing 100 of 214 goals/).getAttribute('role')).toBe('status');
  });

  it('renders NO notice when nothing is hidden — paired control for the above', () => {
    goalCols([{ id: 'g1', title: 'Ship the thing', status: 'active' }], goalsTruncationNotice(4, 4));
    expect(document.body.textContent).not.toContain('Showing');
  });
});

describe('the H2 weighted Plans board (plan-visibility-revamp-2026-08-23 P-006)', () => {
  const NOW_W = Date.parse('2026-08-23T12:00:00.000Z');

  function wplan(over: Partial<HudPlanInput> = {}): HudPlanInput {
    return {
      slug: 'a-plan',
      title: 'A plan',
      status: 'active',
      updated: '2026-08-23T11:00:00.000Z',
      harnessSlug: 'papercusp',
      itemCounts: {},
      ...over,
    };
  }

  /** One plan per column: needs-you, working, blocked, ready, done. */
  function fiveColumnBoard() {
    return buildPlanBoard(
      [
        wplan({ slug: 'ask-plan', itemCounts: { 'needs-human': 1 } }),
        wplan({ slug: 'wip-plan', itemCounts: { wip: 1 } }),
        wplan({ slug: 'stuck-plan', itemCounts: { blocked: 1 } }),
        wplan({ slug: 'queued-plan', itemCounts: { todo: 1 } }),
        wplan({ slug: 'done-plan', itemCounts: { done: 2 } }),
      ],
      { nowMs: NOW_W },
    );
  }

  function weightedCols(over: Partial<React.ComponentProps<typeof HudEntityColumns>> = {}) {
    const onFocusColumn = vi.fn();
    const onSort = vi.fn();
    render(
      <HudEntityColumns
        board={fiveColumnBoard()}
        focusColumn={null}
        onFocusColumn={onFocusColumn}
        query=""
        onQuery={() => {}}
        loading={false}
        error={null}
        emptyLabel="No plans."
        noun="plans"
        weighted
        sort="last-work"
        onSort={onSort}
        {...over}
      />,
    );
    return { onFocusColumn, onSort };
  }

  it('replaces the bare count chips with the labeled segmented strip', () => {
    weightedCols();
    const strip = screen.getByRole('group', { name: 'Filter plans by column' });
    expect(strip).toBeTruthy();
    // Labeled segments with counts — "Needs you 1", not the chips' "1 needs you".
    expect(screen.getByRole('button', { name: 'All 5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Needs you 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Working 1' })).toBeTruthy();
    // The chip strip is genuinely REPLACED, not rendered alongside.
    expect(document.querySelector('.hud__counts')).toBeNull();
  });

  it('drives the same column focus from the segments, with All clearing it', () => {
    const { onFocusColumn } = weightedCols();
    fireEvent.click(screen.getByRole('button', { name: 'Needs you 1' }));
    expect(onFocusColumn).toHaveBeenCalledWith('needs-you');
    fireEvent.click(screen.getByRole('button', { name: 'All 5' }));
    expect(onFocusColumn).toHaveBeenCalledWith(null);
  });

  it('collapses Ready and Done to count rails and keeps the card columns expanded', () => {
    weightedCols();
    // The rails are buttons whose accessible name carries the count…
    expect(screen.getByRole('button', { name: 'Show Ready (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show Done (1)' })).toBeTruthy();
    // …and the collapsed columns render no card section, while the three
    // attention columns keep theirs.
    expect(screen.queryByRole('region', { name: 'Ready' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Done' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Working' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Blocked' })).toBeTruthy();
  });

  it('expands a rail through the existing column focus on click', () => {
    const { onFocusColumn } = weightedCols();
    fireEvent.click(screen.getByRole('button', { name: 'Show Done (1)' }));
    expect(onFocusColumn).toHaveBeenCalledWith('done');
  });

  it('renders a focused rail column as a full column — the rail is gone', () => {
    weightedCols({ focusColumn: 'done' });
    expect(screen.getByRole('region', { name: 'Done' })).toBeTruthy();
    expect(document.body.textContent).toContain('done-plan');
    expect(screen.queryByRole('button', { name: 'Show Done (1)' })).toBeNull();
  });

  it('marks the weighted grid so the CSS can weight the columns', () => {
    weightedCols();
    expect(document.querySelector('.hud__cols--weighted')).toBeTruthy();
  });

  it('renders the sort picker showing the picked axis', () => {
    weightedCols();
    expect(screen.getByTestId('hud-entity-sort')).toBeTruthy();
    // The Combobox displays the selected option's label.
    expect((screen.getByTestId('hud-entity-sort') as HTMLInputElement).value).toBe('Last work');
  });

  it('grows none of this on an unweighted board — the other tabs are untouched', () => {
    render(
      <HudEntityColumns
        board={fiveColumnBoard()}
        focusColumn={null}
        onFocusColumn={() => {}}
        query=""
        onQuery={() => {}}
        loading={false}
        error={null}
        emptyLabel="No plans."
        noun="plans"
      />,
    );
    expect(document.querySelector('.hud__seg')).toBeNull();
    expect(document.querySelector('.hud__cols--weighted')).toBeNull();
    expect(document.querySelector('.hud__railcol')).toBeNull();
    expect(screen.queryByTestId('hud-entity-sort')).toBeNull();
    expect(document.querySelector('.hud__counts')).toBeTruthy();
    // All five columns render as full card sections.
    expect(screen.getByRole('region', { name: 'Ready' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Done' })).toBeTruthy();
  });
});
