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
import { buildWorkItemBoard, type HudWorkItemInput } from './hud-entity-board';
import type { HudAsk } from './hud-board-model';

vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
});
