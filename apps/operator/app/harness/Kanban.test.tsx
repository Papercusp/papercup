// @vitest-environment jsdom
//
// Kanban — vendored Kibo-UI board primitives. The drag derivation (column flip
// on drag-over, same-list reorder on drag-end, per-column card partition) is
// extracted into pure helpers and tested branch-by-branch; a render-smoke drives
// KanbanProvider with a couple of columns to confirm cards render in their
// columns. @dnd-kit DnD itself is exercised by e2e, not here.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  computeColumnFlip,
  computeReorder,
  cardsForColumn,
  KanbanProvider,
  KanbanBoard,
  KanbanCards,
  KanbanCard,
  KanbanHeader,
  type KanbanItemProps,
  type KanbanColumnProps,
} from './Kanban';

afterEach(cleanup);

const COLUMNS: KanbanColumnProps[] = [
  { id: 'todo', name: 'Todo' },
  { id: 'done', name: 'Done' },
];

function mkData(): KanbanItemProps[] {
  return [
    { id: 'a', name: 'Card A', column: 'todo' },
    { id: 'b', name: 'Card B', column: 'todo' },
    { id: 'c', name: 'Card C', column: 'done' },
  ];
}

describe('cardsForColumn', () => {
  it('returns only the cards in the column, in data order', () => {
    const data = mkData();
    expect(cardsForColumn(data, 'todo').map((c) => c.id)).toEqual(['a', 'b']);
    expect(cardsForColumn(data, 'done').map((c) => c.id)).toEqual(['c']);
  });
  it('returns an empty array for a column with no cards', () => {
    expect(cardsForColumn(mkData(), 'archive')).toEqual([]);
  });
});

describe('computeColumnFlip', () => {
  it('moves the active card to the column of the card it is dragged over', () => {
    const out = computeColumnFlip(mkData(), COLUMNS, 'a', 'c');
    expect(out).not.toBeNull();
    expect(out!.find((i) => i.id === 'a')!.column).toBe('done');
    // It does not mutate the input.
    expect(mkData().find((i) => i.id === 'a')!.column).toBe('todo');
  });

  it('flips to a column when dragged over an empty column header (over.id is a column id)', () => {
    // Only 'a' in todo, drag onto the (empty) "done" column header.
    const data: KanbanItemProps[] = [{ id: 'a', name: 'A', column: 'todo' }];
    const out = computeColumnFlip(data, COLUMNS, 'a', 'done');
    expect(out).not.toBeNull();
    expect(out!.find((i) => i.id === 'a')!.column).toBe('done');
  });

  it('returns null when the active card is already in the target column', () => {
    // Dragging 'a' over 'b' — both already in todo.
    expect(computeColumnFlip(mkData(), COLUMNS, 'a', 'b')).toBeNull();
  });

  it('returns null when the active id is unknown', () => {
    expect(computeColumnFlip(mkData(), COLUMNS, 'ghost', 'c')).toBeNull();
  });

  it('falls back to the first column when over.id matches nothing', () => {
    // 'c' lives in 'done'; dragging it over an unknown id resolves to columns[0] = 'todo'.
    const out = computeColumnFlip(mkData(), COLUMNS, 'c', 'nonexistent');
    expect(out).not.toBeNull();
    expect(out!.find((i) => i.id === 'c')!.column).toBe('todo');
  });
});

describe('computeReorder', () => {
  it('moves the active card to the over card index (same list)', () => {
    const out = computeReorder(mkData(), 'a', 'b');
    expect(out).not.toBeNull();
    // a and b swap positions; c stays last.
    expect(out!.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns null when dropped on itself', () => {
    expect(computeReorder(mkData(), 'a', 'a')).toBeNull();
  });
});

describe('<KanbanProvider />', () => {
  it('renders each card inside its column', () => {
    const data = mkData();
    render(
      <KanbanProvider columns={COLUMNS} data={data}>
        {(column) => (
          <KanbanBoard id={column.id} key={column.id}>
            <KanbanHeader>{column.name}</KanbanHeader>
            <KanbanCards id={column.id}>
              {(item) => <KanbanCard key={item.id} {...item} />}
            </KanbanCards>
          </KanbanBoard>
        )}
      </KanbanProvider>,
    );
    // All three card names render (default card body shows the name).
    expect(screen.getByText('Card A')).toBeTruthy();
    expect(screen.getByText('Card B')).toBeTruthy();
    expect(screen.getByText('Card C')).toBeTruthy();
    // Column headers render.
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
  });
});
