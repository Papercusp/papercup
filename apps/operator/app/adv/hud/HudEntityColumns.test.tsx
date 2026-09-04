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
  it('renders work-item kinds with the canonical icon-bearing pill', () => {
    renderCols({}, { items: [item({ kind: 'change' })], asks: [] });

    const label = screen.getByText('Change');
    expect(label.parentElement?.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/^change$/)).toBeNull();
  });

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
    // The slug is no longer painted as text (hud-plan-card-density D-001 moved
    // it to the title attribute + aria-label), so assert the CARD is there by
    // its accessible name rather than by hunting its slug in body text.
    expect(document.querySelector('[aria-label="done-plan — A plan"]')).toBeTruthy();
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

describe('the enriched plan card (plan-visibility-revamp-2026-08-23 P-007)', () => {
  const NOW_M = Date.parse('2026-08-23T12:00:00.000Z');
  const OWNER_A = 'su-76a83f22-1111-4ea0-b546-8a692cdc949c';
  const OWNER_B = 'su-6e294c10-2222-40e0-bd98-f88198fe84b4';

  function metaPlan(over: Partial<HudPlanInput> = {}): HudPlanInput {
    return {
      slug: 'rich-plan',
      title: 'A rich plan',
      status: 'active',
      updated: new Date(NOW_M - 2 * 60_000).toISOString(),
      harnessSlug: 'papercusp',
      itemCounts: { done: 3, todo: 5, wip: 1 },
      lastWorkAtMs: NOW_M - 41_000,
      agents: [
        { ownerId: OWNER_A, live: true, intent: 'recording D-001' },
        { ownerId: OWNER_B, live: null },
      ],
      ...over,
    };
  }

  function renderPlanBoard(rows: HudPlanInput[]) {
    return render(
      <HudEntityColumns
        board={buildPlanBoard(rows, { nowMs: NOW_M })}
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
  }

  // ── the compact card: hud-plan-card-density-2026-08-31, D-001 variant B ──
  // The owner's ask was "the title and the now item, the top 2 lines" with the
  // icons "on the right side of the first line". These four tests pin the parts
  // that can regress SILENTLY — a row creeping back, the rail growing until the
  // title has no width left, or the slug reappearing as painted text.

  it('floats the activity rail onto the title line — ⚒ age and the live pill', () => {
    renderPlanBoard([metaPlan()]);
    const rail = document.querySelector('.hud__cardright');
    expect(rail).toBeTruthy();
    expect(rail!.textContent).toContain('⚒ 41s');
    expect(document.querySelector('.hud__liven')!.textContent).toBe('1');
    // ON line 1, not below it. This is the whole ask, so it is asserted
    // structurally rather than trusted to the stylesheet.
    expect(rail!.closest('.hud__card-h')).toBeTruthy();
  });

  it('drops every row that restated something the card already says', () => {
    renderPlanBoard([metaPlan()]);
    expect(document.querySelector('.hud__cardmeta')).toBeNull(); // the old meta row
    expect(document.querySelector('.hud__chips')).toBeNull(); // the chips row
    expect(document.querySelector('.hud__plan')).toBeNull(); // the harness line
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('✎'); // edit age — the rail has no room for both
    expect(text).not.toContain('items'); // n/m items — .hud__track draws it
  });

  it('keeps the RAIL off the title: no avatar stack competing for line 1', () => {
    // Variant B spends the rail on activity, not presence (D-001). Measured:
    // the full former strip is 128px and leaves the title 69px at a 244px card.
    renderPlanBoard([metaPlan()]);
    expect(document.querySelector('.hud__av')).toBeNull();
    expect(document.querySelector('.hud__avs')).toBeNull();
  });

  it('promotes the title to line 1 and keeps the slug as hover + accessible name', () => {
    renderPlanBoard([metaPlan()]);
    const title = document.querySelector('.hud__cardtitle');
    expect(title).toBeTruthy();
    expect(title!.textContent).toBe('A rich plan');
    // The slug is not lost — it is the hover title, alongside the HARNESS, which
    // is the other fact the compact card stopped painting (WI-1743279 F2: the
    // old justification for dropping `card.context` — "it reads `papercusp` on
    // every card here" — is false on an unscoped or multi-harness board).
    expect(title!.getAttribute('title')).toBe('rich-plan · papercusp');
    expect(document.querySelector('.hud__handle')).toBeNull();

    // NOT a claim that this plan MOVED the accessible name: `aria-label` sat on
    // EntityCardBody before this change and is byte-identical after it. Kept as
    // a positive control that the compact tree did not disturb it (F6).
    expect(document.querySelector('[aria-label="rich-plan — A rich plan"]')).toBeTruthy();
  });

  it('falls back to the bare slug as hover title when a card carries no harness', () => {
    // The paired control for the line above: without it, a `title` that ALWAYS
    // appended a separator (`rich-plan · `) would pass the test above and look
    // broken on every context-less card.
    renderPlanBoard([metaPlan({ harnessSlug: null })]);
    expect(document.querySelector('.hud__cardtitle')!.getAttribute('title')).toBe('rich-plan');
  });

  it('renders exception pips from itemCounts — and none when there are none', () => {
    // D-003: the numbers come from the counts, never from parsing "2 blocked"
    // back out of a badge label. needs-you leads, blocked follows.
    renderPlanBoard([metaPlan({ itemCounts: { 'needs-human': 2, blocked: 3, todo: 4 } })]);
    expect([...document.querySelectorAll('.hud__pip')].map((el) => el.textContent)).toEqual([
      '2',
      '3',
    ]);
    cleanup();
    renderPlanBoard([metaPlan()]);
    expect(document.querySelectorAll('.hud__pip')).toHaveLength(0);
  });

  /**
   * D-003 CONTROL — the implementation this criterion exists to exclude: a
   * renderer that parses the digits back out of the BADGE LABELS, in badge
   * order, instead of reading itemCounts.
   *
   * Kept permanently in the suite rather than applied as a one-off mutation
   * probe. A control that lives here re-proves the discrimination on every
   * run and cannot be lost; a probe proves it once, for the version that
   * happened to be on disk that afternoon.
   */
  function labelParsingPips(plan: HudPlanInput): string[] {
    const board = buildPlanBoard([plan], { nowMs: NOW_M });
    const card = board.columns.flatMap((col) => col.cards).find((c) => c.ref === plan.slug);
    return (card?.badges ?? [])
      .map((b) => b.label.match(/\d+/)?.[0])
      .filter((d): d is string => d != null)
      .slice(0, 2);
  }

  it('derives the pips from itemCounts, not from badge labels — a wip count between them proves it', () => {
    // D-003, DISCRIMINATING case. The test above cannot tell the derived
    // implementation from the label-parsing one: with {'needs-human':2,
    // blocked:3} BOTH render ['2','3'], because the two labels carry the same
    // two digits in the same order. A case that passes whichever
    // implementation is underneath discriminates nothing.
    //
    // toPlanCard pushes badges in the order needs-human → wip → blocked →
    // todo, while the pips render needsHumanCount then blockedCount and ignore
    // wip entirely. So a wip count that is present and distinct splits them.
    const discriminating = metaPlan({
      itemCounts: { 'needs-human': 2, wip: 9, blocked: 3, todo: 4 },
    });

    // The control genuinely diverges on this input — otherwise the assertion
    // below is green against BOTH implementations and proves nothing.
    expect(labelParsingPips(discriminating)).toEqual(['2', '9']);

    renderPlanBoard([discriminating]);
    const pips = [...document.querySelectorAll('.hud__pip')].map((el) => el.textContent);
    expect(pips).toEqual(['2', '3']);
    // Stated separately so a failure names the defect rather than a diff: a 9
    // in the pips means the renderer read the wip BADGE, not the wip COUNT.
    expect(pips).not.toContain('9');

    // CALIBRATION — why the case above the discriminating one cannot stand
    // alone: on its input the control agrees with the real implementation, so
    // that test is green under a label-parser too.
    cleanup();
    const indistinguishable = metaPlan({ itemCounts: { 'needs-human': 2, blocked: 3, todo: 4 } });
    expect(labelParsingPips(indistinguishable)).toEqual(['2', '3']);
    renderPlanBoard([indistinguishable]);
    expect([...document.querySelectorAll('.hud__pip')].map((el) => el.textContent)).toEqual([
      '2',
      '3',
    ]);
  });

  it('drops the now line in the settled columns — a Ready plan has no next action', () => {
    // D-002 / variant D, implemented as a TSX branch: the node is absent, not
    // painted invisible, so a screen reader is not offered a line nobody sees.
    renderPlanBoard([metaPlan({ itemCounts: { todo: 3 }, agents: null, nextAction: 'Later' })]);
    expect(document.querySelector('.hud__cardtitle')).toBeTruthy();
    expect(document.querySelector('.hud__entity-why')).toBeNull();
  });

  it('marks fresh ⚒ hot and leaves stale ⚒ quiet, at PlansPane’s shared 1h line', () => {
    renderPlanBoard([
      metaPlan({ slug: 'fresh', lastWorkAtMs: NOW_M - 30 * 60_000 }),
      metaPlan({ slug: 'stale', lastWorkAtMs: NOW_M - 2 * 60 * 60_000 }),
    ]);
    expect(document.querySelectorAll('.hud__mt--hot')).toHaveLength(1);
  });

  it('prefers the who-is-doing-what line over the stored next-action', () => {
    renderPlanBoard([metaPlan({ nextAction: 'Ship the thing' })]);
    const why = document.querySelector('.hud__entity-why');
    expect(why!.textContent).toBe('su-76a83f22: recording D-001');
    // The next-action survives as the hover title, not a lost fact.
    expect(why!.getAttribute('title')).toBe('Ship the thing');
  });

  it('keeps the stored reason line when nobody is on the plan', () => {
    renderPlanBoard([metaPlan({ agents: null, nextAction: 'Ship the thing' })]);
    expect(document.querySelector('.hud__entity-why')!.textContent).toBe('Ship the thing');
  });

  it('draws the progress track from settled-over-total and omits it with no items', () => {
    renderPlanBoard([metaPlan()]);
    const fill = document.querySelector<HTMLElement>('.hud__track-fill');
    expect(fill).toBeTruthy();
    expect(fill!.style.width).toBe('33%');
    cleanup();
    renderPlanBoard([metaPlan({ itemCounts: {}, agents: null })]);
    expect(document.querySelector('.hud__track')).toBeNull();
  });

  it('suppresses the header age on plan cards — ⚒ in the rail is the age that matters', () => {
    // Was "✎ already says it in the meta row" until
    // hud-plan-card-density-2026-08-31 D-001 dropped BOTH the meta row and ✎.
    // The assertion is unchanged and still correct; only its reason moved — the
    // header age is redundant because the rail's ⚒ last-work carries the
    // recency signal a reader actually scans for.
    renderPlanBoard([metaPlan()]);
    expect(document.querySelector('.hud__age')).toBeNull();
    expect(document.querySelector('.hud__cardright')!.textContent).toContain('⚒');
  });
});

/**
 * The D-004 SCOPING CONTROL — hud-plan-card-density-2026-08-31 P-005.
 *
 * The compact form is discriminated on `card.plan`, which only `toPlanCard`
 * writes. That is one boolean standing between "the Plans board got denser" and
 * "every board in the HUD silently lost its slug, its chips and its reason
 * line", and nothing in the plan-card suite above can catch a regression in it:
 * those tests only ever render plan cards, so a branch that started matching
 * everything would leave all of them green.
 *
 * So this control renders the OTHER card kind and asserts the legacy tree
 * survives verbatim. It is the falsifier for D-004, and it fails in exactly the
 * direction that matters — widening the branch, not narrowing it.
 */
describe('the compact form is scoped to PLAN cards only (D-004)', () => {
  /* EVERY non-plan board that shares EntityCardBody gets its own case, and that
     breadth is the point — WI-1743279 F1 showed why a single representative is
     not enough. The control originally rendered only a WORK-ITEM card, and
     against that version the discriminator could be widened from
     `card.plan ?` to `card.plan ?? card.goal ?` with the whole suite staying
     green: a work-item card carries neither field, so it cannot see a widening
     that swallows goal cards. One case per kind is what closes that.

     EntityCardBody serves goal, work-item and plan cards. SESSION cards are NOT
     in this population despite D-004's wording — HudBoard renders those with its
     own component — so there is deliberately no session case here; adding a
     fake one would assert against a tree this file does not own. */
  const NON_PLAN_BOARDS: ReadonlyArray<{
    kind: string;
    render: () => void;
    handle: string;
    reason: string;
  }> = [
    {
      kind: 'work-item',
      render: () => renderCols({}, { items: [item({ id: 'WI-9', title: 'A real work item' })] }),
      handle: 'WI-9',
      reason: 'A real work item',
    },
    {
      kind: 'goal',
      render: () =>
        render(
          <HudEntityColumns
            board={buildGoalBoard([{ id: 'g1', title: 'Ship the thing', status: 'active' }], {
              nowMs: NOW,
            })}
            focusColumn={null}
            onFocusColumn={vi.fn()}
            query=""
            onQuery={vi.fn()}
            loading={false}
            error={null}
            emptyLabel="No goals yet."
            noun="goals"
          />,
        ),
      handle: 'g1',
      reason: 'Ship the thing',
    },
  ];

  for (const board of NON_PLAN_BOARDS) {
    it(`leaves a ${board.kind} card on the legacy tree: handle + reason, no compact title`, () => {
      board.render();

      // What a non-plan card MUST still have. Matched by VALUE, not by taking
      // the first node: the goals board injects its own "Start a goal" affordance
      // card (ref '+') ahead of the real cards, so a bare querySelector would
      // assert against the affordance and never see the goal card at all.
      const handles = [...document.querySelectorAll('.hud__handle')].map((el) => el.textContent);
      const reasons = [...document.querySelectorAll('.hud__reason')].map((el) => el.textContent);
      expect(handles).toContain(board.handle);
      expect(reasons).toContain(board.reason);

      // What only a plan card may grow.
      expect(document.querySelector('.hud__cardtitle')).toBeNull();
      expect(document.querySelector('.hud__cardright')).toBeNull();
      expect(document.querySelector('.hud__pip')).toBeNull();
    });
  }
});
