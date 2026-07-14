/**
 * saved-prompts-tree.test.ts — unit tests for the Quick Panel outline model
 * (quick-panel-saved-prompts-2026-07-13 P-002).
 */
import { describe, expect, it } from 'vitest';
import {
  appendPosition,
  breadcrumbOf,
  buildPromptTree,
  displayTitle,
  extractTags,
  extractVariables,
  fillVariables,
  indent,
  insertAfter,
  isCompleted,
  isFolder,
  moveDown,
  moveUp,
  outdent,
  projectDrop,
  subtreeIds,
  visibleRows,
  type MoveAssignment,
  type PromptNodeFields,
  type VisibleOpts,
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
    completedAt: null,
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

function visibleIds(rows: PromptNodeFields[], opts?: VisibleOpts): string[] {
  return visibleRows(buildPromptTree(rows), opts).map((v) => v.node.row.id);
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
    expect(visibleIds(rows, { filter: 'summarize' })).toEqual(['closed', 'hidden']);
  });

  it('filter matches the display title and the slug name', () => {
    expect(visibleIds(rows, { filter: 'ship-it' })).toEqual(['top', 'kid']);
  });

  it('zoom re-roots at the node’s children, ignoring its own collapsed flag', () => {
    expect(visibleIds(rows, { zoomId: 'closed' })).toEqual(['hidden']);
    const v = visibleRows(buildPromptTree(rows), { zoomId: 'closed' });
    expect(v[0].depth).toBe(0);
  });

  it('zoom with an unknown id falls back to home', () => {
    expect(visibleIds(rows, { zoomId: 'nope' })).toEqual(visibleIds(rows));
  });

  it('filter applies inside the zoom only', () => {
    expect(visibleIds(rows, { zoomId: 'top', filter: 'review' })).toEqual(['kid']);
    expect(visibleIds(rows, { zoomId: 'top', filter: 'summarize' })).toEqual([]);
  });

  it('hideCompleted hides the node and its whole subtree', () => {
    const done = [
      row({ id: 'a', position: 'a0', completedAt: '2026-07-14T00:00:00Z' }),
      row({ id: 'a1', parentId: 'a', position: 'a0' }),
      row({ id: 'b', position: 'a1' }),
    ];
    expect(visibleIds(done)).toEqual(['a', 'a1', 'b']);
    expect(visibleIds(done, { hideCompleted: true })).toEqual(['b']);
    expect(visibleIds(done, { hideCompleted: true, filter: 'node' })).toEqual(['b']);
  });
});

describe('breadcrumbOf / subtreeIds', () => {
  const rows = [
    row({ id: 'a', position: 'a0', title: 'A' }),
    row({ id: 'b', parentId: 'a', position: 'a0', title: 'B' }),
    row({ id: 'c', parentId: 'b', position: 'a0', title: 'C' }),
    row({ id: 'x', position: 'a1' }),
  ];

  it('breadcrumbOf returns the chain root-first, including the node', () => {
    const model = buildPromptTree(rows);
    expect(breadcrumbOf(model, 'c').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(breadcrumbOf(model, 'a').map((r) => r.id)).toEqual(['a']);
    expect(breadcrumbOf(model, 'nope')).toEqual([]);
  });

  it('subtreeIds includes the node itself and every descendant', () => {
    const model = buildPromptTree(rows);
    expect([...subtreeIds(model, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...subtreeIds(model, 'c')]).toEqual(['c']);
    expect(subtreeIds(model, 'nope').size).toBe(0);
  });
});

describe('projectDrop', () => {
  const dragRows = () => [
    row({ id: 'a', position: 'a0' }),
    row({ id: 'b', position: 'a1' }),
    row({ id: 'c', position: 'a2' }),
    row({ id: 'c1', parentId: 'c', position: 'a0' }),
  ];
  const flatFor = (rows: PromptNodeFields[], activeId: string, opts?: VisibleOpts) => {
    const model = buildPromptTree(rows);
    const drop = subtreeIds(model, activeId);
    drop.delete(activeId); // descendants leave the list; the active row stays
    return {
      model,
      flat: visibleRows(model, opts).filter((v) => !drop.has(v.node.row.id)),
    };
  };

  it('reorders within the same sibling list (drag a over b)', () => {
    const rows = dragRows();
    const { model, flat } = flatFor(rows, 'a');
    const p = projectDrop(model, flat, 'a', 'b', 0);
    expect(p).not.toBeNull();
    expect(p!.parentId).toBeNull();
    expect(visibleIds(apply(rows, p!.assignments))).toEqual(['b', 'a', 'c', 'c1']);
  });

  it('drops to the end of the list at root depth', () => {
    const rows = dragRows();
    const { model, flat } = flatFor(rows, 'a');
    const p = projectDrop(model, flat, 'a', 'c1', 0);
    expect(p).not.toBeNull();
    expect(p!.parentId).toBeNull();
    expect(visibleIds(apply(rows, p!.assignments))).toEqual(['b', 'c', 'c1', 'a']);
  });

  it('a deeper desired depth reparents into the row above', () => {
    const rows = dragRows();
    const { model, flat } = flatFor(rows, 'a');
    const p = projectDrop(model, flat, 'a', 'c1', 1);
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('c');
    const after = buildPromptTree(apply(rows, p!.assignments));
    expect(after.byId.get('a')?.parent?.row.id).toBe('c');
    expect(visibleIds(apply(rows, p!.assignments))).toEqual(['b', 'c', 'c1', 'a']);
  });

  it('clamps depth between the surrounding rows (no orphaned gap)', () => {
    const rows = dragRows();
    const { model, flat } = flatFor(rows, 'a');
    // Between c and its child c1 the only legal depth is 1 (inside c).
    const p = projectDrop(model, flat, 'a', 'c', 0);
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('c');
    // And a silly-deep desired depth clamps to prev.depth + 1.
    const p2 = projectDrop(model, flat, 'a', 'c1', 9);
    expect(p2!.parentId).toBe('c1');
  });

  it('refuses to make a node its own descendant', () => {
    const rows = dragRows();
    const model = buildPromptTree(rows);
    // Malformed flat (descendant not removed) — the guard still refuses.
    const flat = visibleRows(model);
    const p = projectDrop(model, flat, 'c', 'c1', 1);
    expect(p).toBeNull();
  });

  it('parents depth-0 drops to the zoom root inside a zoom', () => {
    const rows = dragRows();
    const { model } = flatFor(rows, 'c1');
    const flat = visibleRows(model, { zoomId: 'c' });
    const extra = row({ id: 'c2', parentId: 'c', position: 'a1' });
    const zoomModel = buildPromptTree([...rows, extra]);
    const zoomFlat = visibleRows(zoomModel, { zoomId: 'c' });
    const p = projectDrop(zoomModel, zoomFlat, 'c1', 'c2', 0, 'c');
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('c');
    expect(visibleIds(apply([...rows, extra], p!.assignments), { zoomId: 'c' })).toEqual([
      'c2',
      'c1',
    ]);
    void flat;
  });

  it('resequences legacy NULL-position siblings alongside the drop', () => {
    const rows = [
      row({ id: 'p', position: null, title: 'A' }),
      row({ id: 'q', position: null, title: 'B' }),
      row({ id: 'r', position: null, title: 'C' }),
    ];
    const { model, flat } = flatFor(rows, 'r');
    const p = projectDrop(model, flat, 'r', 'p', 0);
    expect(p).not.toBeNull();
    expect(p!.assignments.length).toBe(3);
    expect(visibleIds(apply(rows, p!.assignments))).toEqual(['r', 'p', 'q']);
  });

  it('unknown ids are null', () => {
    const rows = dragRows();
    const { model, flat } = flatFor(rows, 'a');
    expect(projectDrop(model, flat, 'nope', 'b', 0)).toBeNull();
    expect(projectDrop(model, flat, 'a', 'nope', 0)).toBeNull();
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

  it('appendPosition skips trailing legacy NULL-position siblings (WI-4806)', () => {
    // NULL-position rows sort AFTER positioned ones — the append key must
    // still land past the highest DEFINED key, not restart at 'a0'.
    const rows = [
      row({ id: 'a', position: 'a0' }),
      row({ id: 'b', position: 'a1' }),
      row({ id: 'legacy', position: null, title: 'Zzz' }),
    ];
    const pos = appendPosition(buildPromptTree(rows), null);
    expect(pos > 'a1').toBe(true);
  });

  it('insertAfter a leaf places the new node as the next sibling', () => {
    const rows = positioned();
    const p = insertAfter(buildPromptTree(rows), 'a');
    expect(p).not.toBeNull();
    expect(p!.parentId).toBeNull();
    expect(p!.assignments).toEqual([]);
    // between a (a0) and b (a1)
    expect(p!.position > 'a0' && p!.position < 'a1').toBe(true);
  });

  it('insertAfter the last sibling appends past it', () => {
    const p = insertAfter(buildPromptTree(positioned()), 'c1');
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('c');
    expect(p!.position > 'a0').toBe(true);
  });

  it('insertAfter an EXPANDED parent creates its first child', () => {
    const p = insertAfter(buildPromptTree(positioned()), 'c');
    expect(p).not.toBeNull();
    expect(p!.parentId).toBe('c');
    expect(p!.position < 'a0').toBe(true); // before existing child c1 (a0)
  });

  it('insertAfter a COLLAPSED parent creates a sibling instead', () => {
    const rows = [
      row({ id: 'a', position: 'a0' }),
      row({ id: 'c', position: 'a2', collapsed: true }),
      row({ id: 'c1', parentId: 'c', position: 'a0' }),
    ];
    const p = insertAfter(buildPromptTree(rows), 'c');
    expect(p).not.toBeNull();
    expect(p!.parentId).toBeNull();
    expect(p!.position > 'a2').toBe(true);
  });

  it('insertAfter resequences legacy NULL-position siblings', () => {
    const rows = [
      row({ id: 'p', position: null, title: 'A' }),
      row({ id: 'q', position: null, title: 'B' }),
    ];
    const p = insertAfter(buildPromptTree(rows), 'p');
    expect(p).not.toBeNull();
    expect(p!.assignments.length).toBe(2); // full resequence rides along
    const resequenced = apply(rows, p!.assignments);
    const created = row({ id: 'new', parentId: p!.parentId, position: p!.position, title: 'x' });
    expect(visibleIds([...resequenced, created])).toEqual(['p', 'new', 'q']);
  });

  it('insertAfter an unknown id is null', () => {
    expect(insertAfter(buildPromptTree(positioned()), 'nope')).toBeNull();
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

  it('isCompleted keys on completedAt', () => {
    expect(isCompleted({ completedAt: null })).toBe(false);
    expect(isCompleted({})).toBe(false);
    expect(isCompleted({ completedAt: '2026-07-14T00:00:00Z' })).toBe(true);
  });

  it('extractTags finds #tags and @mentions, deduped case-insensitively', () => {
    expect(extractTags('ship #Alpha with @bob and #alpha again (#beta)')).toEqual([
      '#Alpha',
      '@bob',
      '#beta',
    ]);
    expect(extractTags('email a@b.c and c#d are not tags')).toEqual([]);
    expect(extractTags('#123 and #a-b_c')).toEqual(['#123', '#a-b_c']);
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
