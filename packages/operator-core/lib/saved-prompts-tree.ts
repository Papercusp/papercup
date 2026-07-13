/**
 * saved-prompts-tree.ts — pure outline (Workflowy-style) tree utilities for the
 * Quick Panel prompts tab (quick-panel-saved-prompts-2026-07-13 P-002).
 *
 * Operates on the organizer columns migration 598 added to
 * `harness_shared.saved_prompts` (parent_id / position / title / collapsed /
 * pinned). Every row is both an outline node AND (when body is non-empty) a
 * prompt; an empty body marks a pure folder node.
 *
 * Ordering: siblings sort by `position` (a fractional-indexing key), with
 * NULL-position (legacy) rows after positioned rows, by display title. Move
 * operations return ASSIGNMENTS (id → parentId/position patches) rather than
 * mutating: when a sibling list still contains legacy NULL positions the op
 * resequences the whole list once, so callers apply every returned assignment.
 *
 * Pure + isomorphic (no PG, no React) — imported by both the server routes and
 * the panel UI. Position keys come from the maintained `fractional-indexing`
 * package (concurrent inserts never collide, no renumber storms).
 */
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** The organizer-relevant subset of a saved_prompts row (camelCase, store shape). */
export interface PromptNodeFields {
  id: string;
  name: string;
  title: string | null;
  body: string;
  parentId: string | null;
  position: string | null;
  collapsed: boolean;
  pinned: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  archivedAt: string | null;
}

export interface PromptTreeNode<R extends PromptNodeFields = PromptNodeFields> {
  row: R;
  children: PromptTreeNode<R>[];
}

export interface PromptTreeModel<R extends PromptNodeFields = PromptNodeFields> {
  roots: PromptTreeNode<R>[];
  /** id → node + its parent node (null for roots). */
  byId: Map<string, { node: PromptTreeNode<R>; parent: PromptTreeNode<R> | null }>;
}

export interface VisibleRow<R extends PromptNodeFields = PromptNodeFields> {
  node: PromptTreeNode<R>;
  depth: number;
}

/** id → { parentId, position } patch produced by a move/sequence operation. */
export interface MoveAssignment {
  id: string;
  parentId: string | null;
  position: string;
}

/** What the outline shows for a node: free-text title, falling back to the slug name. */
export function displayTitle(row: Pick<PromptNodeFields, 'name' | 'title'>): string {
  const t = row.title?.trim();
  return t && t.length > 0 ? t : row.name;
}

/** A node with an empty body is a pure folder (never materialized as a command). */
export function isFolder(row: Pick<PromptNodeFields, 'body'>): boolean {
  return row.body.trim().length === 0;
}

function siblingCompare(a: PromptNodeFields, b: PromptNodeFields): number {
  const ap = a.position;
  const bp = b.position;
  if (ap !== null && bp !== null && ap !== bp) return ap < bp ? -1 : 1;
  if (ap !== null && bp === null) return -1; // positioned before legacy
  if (ap === null && bp !== null) return 1;
  const byTitle = displayTitle(a).localeCompare(displayTitle(b));
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the outline from flat rows. Archived rows are excluded. Orphans
 * (parent missing or part of a cycle) surface as roots rather than vanishing.
 */
export function buildPromptTree<R extends PromptNodeFields>(rows: R[]): PromptTreeModel<R> {
  const live = rows.filter((r) => r.archivedAt === null || r.archivedAt === undefined);
  const nodes = new Map<string, PromptTreeNode<R>>();
  for (const row of live) nodes.set(row.id, { row, children: [] });

  const roots: PromptTreeNode<R>[] = [];
  for (const node of nodes.values()) {
    const pid = node.row.parentId;
    const parent = pid ? nodes.get(pid) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Cycle guard: anything unreachable from the roots (a parent loop in
  // hand-corrupted data) is promoted to a root so it stays visible. Severing
  // the promoted node's own parent edge breaks the cycle, so the tree below
  // is edge-consistent (no back-edges for sort/flatten to recurse into).
  const reachable = new Set<string>();
  const walk = (n: PromptTreeNode<R>) => {
    if (reachable.has(n.row.id)) return;
    reachable.add(n.row.id);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  for (const node of nodes.values()) {
    if (!reachable.has(node.row.id)) {
      const pid = node.row.parentId;
      const parent = pid ? nodes.get(pid) : undefined;
      if (parent) parent.children = parent.children.filter((c) => c !== node);
      roots.push(node);
      walk(node);
    }
  }

  const sortRec = (list: PromptTreeNode<R>[]) => {
    list.sort((a, b) => siblingCompare(a.row, b.row));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  const byId = new Map<string, { node: PromptTreeNode<R>; parent: PromptTreeNode<R> | null }>();
  const index = (n: PromptTreeNode<R>, parent: PromptTreeNode<R> | null) => {
    byId.set(n.row.id, { node: n, parent });
    for (const c of n.children) index(c, n);
  };
  for (const r of roots) index(r, null);

  return { roots, byId };
}

function nodeMatches(row: PromptNodeFields, q: string): boolean {
  return (
    displayTitle(row).toLowerCase().includes(q) ||
    row.name.toLowerCase().includes(q) ||
    row.body.toLowerCase().includes(q)
  );
}

/**
 * Flatten the tree to what the outline renders. Without a filter, children of
 * a collapsed node are hidden. With a filter, collapse is ignored and a node is
 * shown iff it (or a descendant) matches — ancestors of a match stay visible.
 */
export function visibleRows<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  filter?: string,
): VisibleRow<R>[] {
  const q = filter?.trim().toLowerCase();
  const out: VisibleRow<R>[] = [];

  if (!q) {
    const walk = (n: PromptTreeNode<R>, depth: number) => {
      out.push({ node: n, depth });
      if (!n.row.collapsed) for (const c of n.children) walk(c, depth + 1);
    };
    for (const r of model.roots) walk(r, 0);
    return out;
  }

  const subtreeMatches = (n: PromptTreeNode<R>): boolean =>
    nodeMatches(n.row, q) || n.children.some(subtreeMatches);
  const walk = (n: PromptTreeNode<R>, depth: number) => {
    if (!subtreeMatches(n)) return;
    out.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of model.roots) walk(r, 0);
  return out;
}

/** The ordered sibling list a node belongs to (roots when parent is null). */
function siblingListOf<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): { siblings: PromptTreeNode<R>[]; parent: PromptTreeNode<R> | null } | null {
  const entry = model.byId.get(id);
  if (!entry) return null;
  return { siblings: entry.parent ? entry.parent.children : model.roots, parent: entry.parent };
}

/**
 * Effective positions for a sibling list. When every sibling already has a
 * strictly-increasing position, positions are used as-is (no assignments).
 * Otherwise (legacy NULLs / duplicates) the WHOLE list is resequenced once and
 * every sibling appears in the returned assignments.
 */
function effectiveSequence<R extends PromptNodeFields>(
  siblings: PromptTreeNode<R>[],
  parentId: string | null,
): { positions: string[]; assignments: MoveAssignment[] } {
  const ok =
    siblings.every((s) => s.row.position !== null) &&
    siblings.every(
      (s, i) => i === 0 || (siblings[i - 1].row.position as string) < (s.row.position as string),
    );
  if (ok) return { positions: siblings.map((s) => s.row.position as string), assignments: [] };
  const keys = generateNKeysBetween(null, null, siblings.length);
  return {
    positions: keys,
    assignments: siblings.map((s, i) => ({ id: s.row.id, parentId, position: keys[i] })),
  };
}

function mergeMoved(
  assignments: MoveAssignment[],
  moved: MoveAssignment,
): MoveAssignment[] {
  return [...assignments.filter((a) => a.id !== moved.id), moved];
}

/** Position key for appending a new child at the end of `parentId`'s children. */
export function appendPosition<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  parentId: string | null,
): string {
  const siblings = parentId ? (model.byId.get(parentId)?.node.children ?? []) : model.roots;
  const last = siblings.length ? siblings[siblings.length - 1].row.position : null;
  return generateKeyBetween(last ?? null, null);
}

/** Swap with the previous sibling. Null when already first (or unknown id). */
export function moveUp<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i <= 0) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const before = i >= 2 ? positions[i - 2] : null;
  const pos = generateKeyBetween(before, positions[i - 1]);
  return mergeMoved(assignments, { id, parentId, position: pos });
}

/** Swap with the next sibling. Null when already last (or unknown id). */
export function moveDown<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i === -1 || i >= ctx.siblings.length - 1) return null;
  const parentId = ctx.parent?.row.id ?? null;
  const { positions, assignments } = effectiveSequence(ctx.siblings, parentId);
  const after = i + 2 < positions.length ? positions[i + 2] : null;
  const pos = generateKeyBetween(positions[i + 1], after);
  return mergeMoved(assignments, { id, parentId, position: pos });
}

/** Tab: become the last child of the previous sibling. Null when no previous sibling. */
export function indent<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const ctx = siblingListOf(model, id);
  if (!ctx) return null;
  const i = ctx.siblings.findIndex((s) => s.row.id === id);
  if (i <= 0) return null;
  const newParent = ctx.siblings[i - 1];
  const last = newParent.children.length
    ? newParent.children[newParent.children.length - 1].row.position
    : null;
  const pos = generateKeyBetween(last ?? null, null);
  return [{ id, parentId: newParent.row.id, position: pos }];
}

/** Shift-Tab: move to be the sibling right after the current parent. Null for roots. */
export function outdent<R extends PromptNodeFields>(
  model: PromptTreeModel<R>,
  id: string,
): MoveAssignment[] | null {
  const entry = model.byId.get(id);
  if (!entry || !entry.parent) return null;
  const parent = entry.parent;
  const grand = model.byId.get(parent.row.id)?.parent ?? null;
  const grandId = grand?.row.id ?? null;
  const list = grand ? grand.children : model.roots;
  const pi = list.findIndex((s) => s.row.id === parent.row.id);
  const { positions, assignments } = effectiveSequence(list, grandId);
  const after = pi + 1 < positions.length ? positions[pi + 1] : null;
  const pos = generateKeyBetween(positions[pi], after);
  return mergeMoved(assignments, { id, parentId: grandId, position: pos });
}

/**
 * Extract `{{variable}}` placeholders from a prompt body, in first-appearance
 * order, deduplicated. Names are trimmed; empty braces are ignored.
 */
export function extractVariables(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const name = m[1].trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute `{{variable}}` placeholders with the provided values (missing → left as-is). */
export function fillVariables(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw: string) => {
    const name = raw.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}
