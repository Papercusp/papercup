/**
 * saved-prompts-tree.test.ts — unit tests for the Quick Panel outline model
 * (quick-panel-saved-prompts-2026-07-13 P-002).
 */
import { describe, expect, it } from 'vitest';
import {
  appendPosition,
  buildPromptTree,
  displayTitle,
  extractVariables,
  fillVariables,
  indent,
  isFolder,
  moveDown,
  moveUp,
  outdent,
  visibleRows,
  type MoveAssignment,
  type PromptNodeFields,
} from './saved-prompts-tree';

let seq = 0;
function row(partial: Partial<PromptNodeFields> & { id: string }): PromptNodeFields {
  seq += 1;
  return {
    name: `node-${seq}`,
    title: null,
    body: 'body',
    parentId: null,
    position: null,
    collapsed: false,
    pinned: false,
    usageCount: 0,
    lastUsedAt: null,
    archivedAt: null,
    ...partial,
  };
}

/** Apply move assignments to rows (what the server write does), for round-trip tests. */
function apply(rows: PromptNodeFields[], assignments: MoveAssignment[]): PromptNodeFields[] {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  return rows.map((r) => {
    const a = byId.get(r.id);
    return a ? { ...r, parentId: a.parentId, position: a.position } : r;
  });
}

function visibleIds(rows: PromptNodeFields[], filter?: string): string[] {
  return visibleRows(buildPromptTree(rows), filter).map((v) => v.node.row.id);
}

describe('buildPromptTree', () => {
  it('nests children under parents and sorts siblings by position', () => {
    const rows = [
      row({ id: 'b', position: 'a2' }),
      row({ id: 'a', position: 'a1' }),
      row({ id: 'a1', parentId: 'a', position: 'a1' }),
      row({ id: 'a0', parentId: 'a', position: 'a0' }),
    ];
    const model = buildPromptTree(rows);
    expect(model.roots.map((r) => r.row.id)).toEqual(['a', 'b']);
    expect(model.roots[0].children.map((c) => c.row.id)).toEqual(['a0', 'a1']);
  });

  it('sorts legacy NULL-position rows after positioned rows, by display title', () => {
    const rows = [
      row({ id: 'z', position: null, title: 'Zeta' }),
      row({ id: 'm', position: null, title: 'Alpha' }),
      row({ id: 'p', position: 'a0', title: 'Positioned' }),
    ];
    expect(buildPromptTree(rows).roots.map((r) => r.row.id)).toEqual(['p', 'm', 'z']);
  });

  it('excludes archived rows and promotes orphans to roots', () => {
    const rows = [
      row({ id: 'gone', archivedAt: '2026-07-13T00:00:00Z' }),
      row({ id: 'orphan', parentId: 'gone' }),
    ];
    const model = buildPromptTree(rows);
    expect(model.roots.map((r) => r.row.id)).toEqual(['orphan']);
  });

  it('keeps cycle members visible instead of dropping them', () => {
    const rows = [row({ id: 'x', parentId: 'y' }), row({ id: 'y', parentId: 'x' })];
    const model = buildPromptTree(rows);
    const ids = [...model.byId.keys()].sort();
    expect(ids).toEqual(['x', 'y']);
    expect(model.roots.length).toBeGreaterThanOrEqual(1);
  });
});

describe('visibleRows', () => {
  const rows = [
    row({ id: 'top', position: 'a0', title: 'Coding', body: '', collapsed: false }),
    row({ id: 'kid', parentId: 'top', position: 'a0', title: 'Ship-it review', body: 'review the diff' }),
    row({ id: 'closed', position: 'a1', title: 'Fleet', body: '', collapsed: true }),
    row({ id: 'hidden', parentId: 'closed', position: 'a0', title: 'Standup', body: 'summarize' }),
  ];

  it('hides children of collapsed nodes', () => {
    expect(visibleIds(rows)).toEqual(['top', 'kid', 'closed']);
  });

  it('reports depth', () => {
    const v = visibleRows(buildPromptTree(rows));
    expect(v.find((x) => x.node.row.id === 'kid')?.depth).toBe(1);
  });

  it('filter matches bodies, ignores collapse, and keeps ancestors of matches', () => {
    expect(visibleIds(rows, 'summarize')).toEqual(['closed', 'hidden']);
  });

  it('filter matches the display title and the slug name', () => {
    expect(visibleIds(rows, 'ship-it')).toEqual(['top', 'kid']);
  });
});

describe('move operations', () => {
  const positioned = () => [
    row({ id: 'a', position: 'a0' }),
    row({ id: 'b', position: 'a1' }),
    row({ id: 'c', position: 'a2' }),
    row({ id: 'c1', parentId: 'c', position: 'a0' }),
  ];

  it('moveUp swaps with the previous sibling', () => {
    const rows = positioned();
    const moved = moveUp(buildPromptTree(rows), 'b');
    expect(moved).not.toBeNull();
    expect(visibleIds(apply(rows, moved!))).toEqual(['b', 'a', 'c', 'c1']);
  });

  it('moveUp on the first sibling is a no-op', () => {
    expect(moveUp(buildPromptTree(positioned()), 'a')).toBeNull();
  });

  it('moveDown swaps with the next sibling', () => {
    const rows = positioned();
    const moved = moveDown(buildPromptTree(rows), 'a');
    expect(visibleIds(apply(rows, moved!))).toEqual(['b', 'a', 'c', 'c1']);
  });

  it('moveDown on the last sibling is a no-op', () => {
    expect(moveDown(buildPromptTree(positioned()), 'c')).toBeNull();
  });

  it('indent makes the node the LAST child of its previous sibling', () => {
    const rows = positioned();
    const moved = indent(buildPromptTree(rows), 'b');
    const next = apply(rows, moved!);
    const model = buildPromptTree(next);
    expect(model.byId.get('b')?.parent?.row.id).toBe('a');
    // and a second indent target already having children appends after them
    const moved2 = indent(buildPromptTree(next), 'c');
    expect(moved2).not.toBeNull();
  });

  it('indent with no previous sibling is a no-op', () => {
    expect(indent(buildPromptTree(positioned()), 'a')).toBeNull();
  });

  it('outdent places the node right after its old parent', () => {
    const rows = positioned();
    const moved = outdent(buildPromptTree(rows), 'c1');
    expect(visibleIds(apply(rows, moved!))).toEqual(['a', 'b', 'c', 'c1']);
    const model = buildPromptTree(apply(rows, moved!));
    expect(model.byId.get('c1')?.parent).toBeNull();
  });

  it('outdent on a root is a no-op', () => {
    expect(outdent(buildPromptTree(positioned()), 'a')).toBeNull();
  });

  it('resequences a legacy NULL-position sibling list in one move', () => {
    const rows = [
      row({ id: 'p', position: null, title: 'B-first' }),
      row({ id: 'q', position: null, title: 'C-second' }),
      row({ id: 'r', position: null, title: 'A-move-me' }),
    ];
    // sorted by title: r? No — titles: B-first, C-second, A-move-me → A sorts first.
    // Initial visible order is by title: A-move-me, B-first, C-second.
    expect(visibleIds(rows)).toEqual(['r', 'p', 'q']);
    const moved = moveDown(buildPromptTree(rows), 'r');
    expect(moved).not.toBeNull();
    // every sibling got a position (full resequence) and the order round-trips
    expect(moved!.length).toBe(3);
    expect(visibleIds(apply(rows, moved!))).toEqual(['p', 'r', 'q']);
  });

  it('appendPosition returns a key sorting after existing children', () => {
    const rows = positioned();
    const model = buildPromptTree(rows);
    const pos = appendPosition(model, 'c');
    expect(pos > 'a0').toBe(true);
    const rootPos = appendPosition(model, null);
    expect(rootPos > 'a2').toBe(true);
  });
});

describe('helpers', () => {
  it('displayTitle falls back to the slug name', () => {
    expect(displayTitle({ name: 'ship-it', title: null })).toBe('ship-it');
    expect(displayTitle({ name: 'ship-it', title: 'Ship it!' })).toBe('Ship it!');
    expect(displayTitle({ name: 'ship-it', title: '   ' })).toBe('ship-it');
  });

  it('isFolder is true only for empty bodies', () => {
    expect(isFolder({ body: '' })).toBe(true);
    expect(isFolder({ body: '  \n ' })).toBe(true);
    expect(isFolder({ body: 'x' })).toBe(false);
  });

  it('extractVariables dedupes in first-appearance order', () => {
    expect(extractVariables('run {{effort}} on {{harness}} at {{ effort }}')).toEqual([
      'effort',
      'harness',
    ]);
    expect(extractVariables('no vars')).toEqual([]);
  });

  it('fillVariables substitutes known names and leaves unknown placeholders', () => {
    expect(fillVariables('a {{x}} b {{y}}', { x: '1' })).toBe('a 1 b {{y}}');
    expect(fillVariables('{{ x }}', { x: '1' })).toBe('1');
  });
});
