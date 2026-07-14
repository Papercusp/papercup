'use client';

/**
 * PromptsTab — the Quick Panel's default tab: a full Workflowy-style outline
 * over saved prompts (quick-panel-workflowy-clone-2026-07-14, WI-4840;
 * supersedes the two-pane organizer from quick-panel-saved-prompts-2026-07-13).
 *
 * Model (D-003, unchanged): every `harness_shared.saved_prompts` row is both an
 * outline node AND a prompt — the title is the bullet, the BODY IS THE NOTE
 * under it (D-001: single pane, no side detail view); an empty body marks a
 * pure folder (never materialized as a slash command). Prompts double as agent
 * slash commands via launch-time materialization.
 *
 * Workflowy surface:
 *   - Zoom/hoist: click a bullet (or Alt+→ / Ctrl+]) to re-root the outline at
 *     that node; breadcrumbs + Alt+← / Ctrl+[ zoom back out. URL-backed (nuqs
 *     `zoom`), so panel state is deep-linkable and agent-drivable.
 *   - Inline notes: Shift+Enter opens the note (= prompt body) under a bullet.
 *   - Complete: Ctrl+Enter checks a node off (strikethrough); the toolbar can
 *     hide completed subtrees (nuqs `done=hide`).
 *   - Drag: the bullet is the drag handle (@dnd-kit); horizontal offset picks
 *     depth; all placement math is projectDrop() in saved-prompts-tree.
 *   - Tags: #tag / @mention chips parsed from title+note; click = filter.
 *   - Undo/redo: Ctrl+Z / Ctrl+Shift+Z — a bounded client-side inverse-op
 *     journal (D-005); outline delete is an UNDOABLE ARCHIVE (D-004).
 *   - Merge: Backspace at the start of a childless bullet joins it into the
 *     bullet above, Workflowy-style.
 *
 * Data: reads via useSyncQuery('savedPrompts.byScope'); writes via the
 * WebView-hardened CORS-simple POST helpers (D-010) + server-pushed refetch.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Home,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import {
  appendPosition,
  breadcrumbOf,
  buildPromptTree,
  displayTitle,
  extractTags,
  extractVariables,
  fillVariables,
  indent as indentOp,
  insertAfter as insertAfterOp,
  isCompleted,
  isFolder,
  moveDown as moveDownOp,
  moveUp as moveUpOp,
  outdent as outdentOp,
  projectDrop,
  subtreeIds,
  visibleRows,
  type MoveAssignment,
  type PromptNodeFields,
  type PromptTreeModel,
  type VisibleRow,
} from '@papercusp/operator-core/lib/saved-prompts-tree';
import {
  archivePromptNode,
  createPromptNode,
  movePromptNodes,
  recordPromptUse,
  unarchivePromptNodes,
  updatePromptNode,
  type PromptNodeClientPatch,
  type SavedPrompt,
} from '@papercusp/operator-core/lib/saved-prompts-client';
import { Button } from '@/app/harness/Button';
import { Tooltip } from '@/app/harness/Tooltip';
import { useDebouncedSave } from '@/app/harness/useDebouncedSave';

/** Panel operates on the WORKSPACE scope (D-003); harness prompts stay in harness settings. */
const SCOPE_ARGS = {} as const;

/** Must match the CSS depth indent (paddingLeft: BASE + depth * INDENT_PX). */
const INDENT_PX = 18;
const ROW_BASE_PX = 8;

type Row = SavedPrompt & PromptNodeFields;
type Model = PromptTreeModel<Row>;

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Undo journal (D-005) — bounded client-side inverse ops. Honest limits:
// per-window, does not survive reload, does not merge cross-client edits.
// ---------------------------------------------------------------------------

type UndoEntry =
  | { kind: 'create'; id: string }
  | { kind: 'archive'; rootId: string; ids: string[] }
  | { kind: 'move'; before: MoveAssignment[]; after: MoveAssignment[] }
  | { kind: 'patch'; id: string; before: PromptNodeClientPatch; after: PromptNodeClientPatch }
  | { kind: 'batch'; entries: UndoEntry[] };

const JOURNAL_CAP = 100;

/** Current {parentId, position} of every id an assignment batch touches — the inverse move. */
function captureBefore(rows: Row[], assignments: MoveAssignment[]): MoveAssignment[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: MoveAssignment[] = [];
  for (const a of assignments) {
    const r = byId.get(a.id);
    // Legacy NULL positions can't round-trip through the move API; skip them —
    // the resequence they got is a normalization, not user intent to undo.
    if (r && r.position !== null) out.push({ id: r.id, parentId: r.parentId, position: r.position });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tag chips
// ---------------------------------------------------------------------------

function TagChips({ row, onTag }: { row: Row; onTag: (tag: string) => void }) {
  const tags = useMemo(
    () => extractTags(`${row.title ?? ''} ${row.body}`).slice(0, 3),
    [row.title, row.body],
  );
  if (tags.length === 0) return null;
  return (
    <span className="pc-qp__tags">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          className="pc-qp__tag"
          onClick={(e) => {
            e.stopPropagation();
            onTag(t);
          }}
        >
          {t}
        </button>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline note (= prompt body) under a bullet — D-001.
// ---------------------------------------------------------------------------

function NodeNote({
  row,
  autoFocus,
  onFocused,
  onOpen,
  onSave,
  onEscape,
}: {
  row: Row;
  autoFocus: boolean;
  onFocused: () => void;
  /** Fired on focus so the parent keeps the note mounted while it empties. */
  onOpen: () => void;
  onSave: (next: string) => void;
  onEscape: () => void;
}) {
  const [text, setText] = useState(row.body);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focused) setText(row.body);
  }, [row.body, focused]);

  const { flush } = useDebouncedSave(text, async (v) => {
    if (v !== row.body) onSave(v);
  });

  // Workflowy note sizing: clamped to one dim line while unfocused (CSS),
  // auto-grown to its content while editing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (focused) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    } else {
      el.style.height = '';
    }
  }, [text, focused]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      const end = ref.current.value.length;
      ref.current.setSelectionRange(end, end);
      onFocused();
    }
  }, [autoFocus, onFocused]);

  return (
    <textarea
      ref={ref}
      className="pc-qp__note"
      rows={1}
      value={text}
      placeholder="Note / prompt text… ({{variables}} fill at copy time)"
      aria-label={`Note of ${displayTitle(row)}`}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => {
        setFocused(true);
        onOpen();
      }}
      onBlur={() => {
        setFocused(false);
        void flush();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void flush();
          onEscape();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Inline affordances on the selected bullet — the prompt superpowers that the
// retired side pane used to host (/name, usage, pin, copy + var fill, delete).
// ---------------------------------------------------------------------------

function NodeAffordances({
  row,
  onCopy,
  onTogglePin,
  onToggleComplete,
  onArchive,
}: {
  row: Row;
  onCopy: (values: Record<string, string>) => void;
  onTogglePin: () => void;
  onToggleComplete: () => void;
  onArchive: () => void;
}) {
  const [varsOpen, setVarsOpen] = useState(false);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const vars = useMemo(() => extractVariables(row.body), [row.body]);
  const folder = isFolder(row);
  const done = isCompleted(row);

  return (
    <div className="pc-qp__afford">
      <Tooltip label={done ? 'Un-complete (Ctrl+Enter)' : 'Complete (Ctrl+Enter)'}>
        <button
          type="button"
          className={`pc-qp__iconbtn${done ? ' on' : ''}`}
          aria-pressed={done}
          onClick={onToggleComplete}
        >
          <Check size={13} />
        </button>
      </Tooltip>
      <Tooltip label={row.pinned ? 'Unpin' : 'Pin to the top strip'}>
        <button
          type="button"
          className={`pc-qp__iconbtn${row.pinned ? ' on' : ''}`}
          aria-pressed={row.pinned}
          onClick={onTogglePin}
        >
          {row.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      </Tooltip>
      {!folder && (
        <Tooltip label="Copy prompt text">
          <button
            type="button"
            className="pc-qp__iconbtn"
            onClick={() => {
              if (vars.length > 0) setVarsOpen((v) => !v);
              else onCopy({});
            }}
          >
            <Copy size={13} />
          </button>
        </Tooltip>
      )}
      {!folder && <code className="pc-qp__name">/{row.name}</code>}
      {row.usageCount > 0 && <span className="pc-qp__usemeta">used {row.usageCount}×</span>}
      {relTime(row.lastUsedAt) && <span className="pc-qp__usemeta">last {relTime(row.lastUsedAt)}</span>}
      <span className="pc-qp__affordspacer" />
      <Tooltip label="Delete (undoable)">
        <button type="button" className="pc-qp__iconbtn" onClick={onArchive}>
          <Trash2 size={13} />
        </button>
      </Tooltip>
      {varsOpen && vars.length > 0 && (
        <div className="pc-qp__vars">
          <span className="pc-qp__varslabel">Fill on copy:</span>
          {vars.map((v) => (
            <label key={v} className="pc-qp__varfield">
              <span className="pc-qp__varname">{v}</span>
              <input
                value={varValues[v] ?? ''}
                onChange={(e) => setVarValues((s) => ({ ...s, [v]: e.target.value }))}
                aria-label={`Value for ${v}`}
              />
            </label>
          ))}
          <Button
            variant="primary"
            onClick={() => {
              onCopy(varValues);
              setVarsOpen(false);
            }}
          >
            <Copy size={12} /> Copy
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline-editable node title — the outline text IS the editor.
// ---------------------------------------------------------------------------

function NodeTitleInput({
  row,
  hasChildren,
  autoFocus,
  caretTo,
  presetText,
  onFocused,
  onFocusRow,
  onCreateAfter,
  onMove,
  onNav,
  onDeleteEmpty,
  onMergeUp,
  onOpenNote,
  onToggleComplete,
  onZoomIn,
  onZoomOut,
  onSaveTitle,
}: {
  row: Row;
  hasChildren: boolean;
  autoFocus: boolean;
  caretTo: number | null;
  presetText: string | null;
  onFocused: () => void;
  onFocusRow: () => void;
  onCreateAfter: () => void;
  onMove: (dir: 'up' | 'down' | 'indent' | 'outdent') => void;
  onNav: (delta: 1 | -1) => void;
  onDeleteEmpty: () => void;
  onMergeUp: (danglingText: string) => void;
  onOpenNote: () => void;
  onToggleComplete: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSaveTitle: (next: string) => void;
}) {
  const [text, setText] = useState(row.title ?? '');
  const focusedRef = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  // Mirror external renames while not editing.
  useEffect(() => {
    if (!focusedRef.current) setText(row.title ?? '');
  }, [row.title]);


  // Set when a merge/delete has CONSUMED this input's text — the row is being
  // archived, and every later save path (debounce timer, blur flush, unmount
  // flush) must treat the edit as discarded or it writes the title onto the
  // archived node and pushes a stray undo entry. Typing again re-arms saves.
  const consumedRef = useRef(false);

  const { flush, cancel } = useDebouncedSave(text, async (v) => {
    if (consumedRef.current) return;
    const next = v.trim();
    if (!next || next === displayTitle(row)) return;
    onSaveTitle(next);
  });

  useEffect(() => {
    if (autoFocus && ref.current) {
      // A merge lands its joined title here before the refetch delivers it —
      // the mirror above won't run (the input is being focused), and the caret
      // below must land inside the joined text, so write the DOM value now.
      if (presetText !== null) {
        setText(presetText);
        ref.current.value = presetText;
      }
      ref.current.focus();
      const pos = caretTo ?? ref.current.value.length;
      ref.current.setSelectionRange(pos, pos);
      onFocused();
    }
  }, [autoFocus, caretTo, presetText, onFocused]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && mod) {
        e.preventDefault();
        onToggleComplete();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        void flush().then(onOpenNote);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void flush().then(onCreateAfter);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        onMove(e.shiftKey ? 'outdent' : 'indent');
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        onMove(e.key === 'ArrowUp' ? 'up' : 'down');
      } else if ((e.altKey && e.key === 'ArrowRight') || (mod && e.key === ']')) {
        e.preventDefault();
        void flush().then(onZoomIn);
      } else if ((e.altKey && e.key === 'ArrowLeft') || (mod && e.key === '[')) {
        e.preventDefault();
        void flush().then(onZoomOut);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        onNav(e.key === 'ArrowDown' ? 1 : -1);
      } else if (
        e.key === 'Backspace' &&
        ref.current?.selectionStart === 0 &&
        ref.current?.selectionEnd === 0 &&
        !hasChildren
      ) {
        // Workflowy: backspace at the start of a childless bullet merges it
        // into the bullet above; a truly empty leaf just disappears. The
        // pending debounced title-save must be DISCARDED, not flushed — the
        // merge consumes this text into the row above, and a late flush
        // (timer or unmount) would both write the title onto the archived
        // node and push a stray undo entry on top of the merge batch.
        e.preventDefault();
        consumedRef.current = true;
        cancel();
        if (text.length === 0 && isFolder(row)) onDeleteEmpty();
        else onMergeUp(text);
      } else if (e.key === 'Escape') {
        ref.current?.blur();
      }
    },
    [
      flush,
      cancel,
      onCreateAfter,
      onMove,
      onNav,
      onDeleteEmpty,
      onMergeUp,
      onOpenNote,
      onToggleComplete,
      onZoomIn,
      onZoomOut,
      text,
      hasChildren,
      row,
    ],
  );

  return (
    <input
      ref={ref}
      className="pc-qp__nodetitle"
      value={text}
      placeholder={isFolder(row) && !hasChildren ? 'New prompt…' : row.name}
      aria-label={`Title of ${displayTitle(row)}`}
      onChange={(e) => {
        consumedRef.current = false;
        setText(e.target.value);
      }}
      onFocus={() => {
        focusedRef.current = true;
        onFocusRow();
      }}
      onBlur={() => {
        focusedRef.current = false;
        void flush();
        setText((t) => (t.trim() ? t : (row.title ?? '')));
      }}
      onKeyDown={onKeyDown}
    />
  );
}

// ---------------------------------------------------------------------------
// One outline row: droppable target + bullet drag handle + title + chrome.
// ---------------------------------------------------------------------------

function OutlineRow({
  row,
  depth,
  hasKids,
  selected,
  dragging,
  dropLine,
  canDrag,
  onSelect,
  onToggleCollapse,
  onZoom,
  children,
}: {
  row: Row;
  depth: number;
  hasKids: boolean;
  selected: boolean;
  dragging: boolean;
  dropLine: { depth: number; edge: 'above' | 'below' } | null;
  canDrag: boolean;
  onSelect: () => void;
  onToggleCollapse: () => void;
  onZoom: () => void;
  children: ReactNode;
}) {
  const { setNodeRef: setDropRef } = useDroppable({ id: row.id });
  const {
    setNodeRef: setDragRef,
    listeners,
    attributes,
  } = useDraggable({ id: row.id, disabled: !canDrag });

  const done = isCompleted(row);
  return (
    <div
      ref={setDropRef}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasKids ? !row.collapsed : undefined}
      className={`pc-qp__node${selected ? ' sel' : ''}${isFolder(row) ? ' folder' : ''}${
        done ? ' done' : ''
      }${dragging ? ' dragsrc' : ''}`}
      style={{ paddingLeft: ROW_BASE_PX + depth * INDENT_PX }}
      onClick={onSelect}
    >
      {dropLine && (
        <span
          className={`pc-qp__dropline ${dropLine.edge}`}
          style={{ left: ROW_BASE_PX + dropLine.depth * INDENT_PX + 20 }}
          aria-hidden
        />
      )}
      <button
        type="button"
        className={`pc-qp__caret${hasKids ? '' : ' leaf'}${row.collapsed ? ' closed' : ''}`}
        aria-label={row.collapsed ? 'Expand' : 'Collapse'}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          if (hasKids) onToggleCollapse();
        }}
      >
        <ChevronRight size={11} />
      </button>
      <button
        ref={setDragRef}
        type="button"
        className="pc-qp__bulletbtn"
        aria-label={`Zoom into ${displayTitle(row)} (drag to move)`}
        {...listeners}
        {...attributes}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onZoom();
        }}
      >
        <span className="pc-qp__bullet" aria-hidden />
      </button>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export default function PromptsTab() {
  const { data, invalidate } = useSyncQuery<SavedPrompt>({
    queryName: 'savedPrompts.byScope',
    args: SCOPE_ARGS,
  });

  // Optimistic collapse overlay — a caret toggle shows instantly while the
  // write + sync round-trip settles.
  const [collapseOverlay, setCollapseOverlay] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => {
    const base = (data ?? []) as unknown as Row[];
    return base.map((r) =>
      collapseOverlay[r.id] !== undefined ? { ...r, collapsed: collapseOverlay[r.id] } : r,
    );
  }, [data, collapseOverlay]);

  // URL state (repo rule: user-meaningful state lives in nuqs).
  const [filter, setFilter] = useQueryState('q', parseAsString.withDefault(''));
  const [sel, setSel] = useQueryState('sel', parseAsString.withDefault(''));
  const [zoomParam, setZoom] = useQueryState('zoom', parseAsString.withDefault(''));
  const [doneVis, setDoneVis] = useQueryState(
    'done',
    parseAsStringEnum(['show', 'hide']).withDefault('show'),
  );

  const model: Model = useMemo(() => buildPromptTree(rows), [rows]);
  // A zoom target archived/deleted under us falls back to home.
  const zoom = zoomParam && model.byId.has(zoomParam) ? zoomParam : '';
  const zoomRow = zoom ? (model.byId.get(zoom)?.node.row ?? null) : null;
  const hideCompleted = doneVis === 'hide';

  const visible = useMemo(
    () =>
      visibleRows(model, {
        filter,
        zoomId: zoom || null,
        hideCompleted,
      }),
    [model, filter, zoom, hideCompleted],
  );

  const pinned = useMemo(() => rows.filter((r) => r.pinned && r.archivedAt === null), [rows]);
  const crumbs = useMemo(() => (zoom ? breadcrumbOf(model, zoom) : []), [model, zoom]);

  // ------------------------------------------------------------------ undo
  const journal = useRef<{ undo: UndoEntry[]; redo: UndoEntry[] }>({ undo: [], redo: [] });
  const pushUndo = useCallback((entry: UndoEntry) => {
    journal.current.undo.push(entry);
    if (journal.current.undo.length > JOURNAL_CAP) journal.current.undo.shift();
    journal.current.redo = [];
  }, []);

  const applyEntry = useCallback(
    async (entry: UndoEntry, dir: 'undo' | 'redo'): Promise<void> => {
      switch (entry.kind) {
        case 'create':
          if (dir === 'undo') await archivePromptNode(entry.id);
          else await unarchivePromptNodes([entry.id]);
          return;
        case 'archive':
          if (dir === 'undo') await unarchivePromptNodes(entry.ids);
          else await archivePromptNode(entry.rootId);
          return;
        case 'move': {
          const a = dir === 'undo' ? entry.before : entry.after;
          if (a.length > 0) await movePromptNodes(a);
          return;
        }
        case 'patch':
          await updatePromptNode(entry.id, dir === 'undo' ? entry.before : entry.after);
          return;
        case 'batch': {
          const list = dir === 'undo' ? [...entry.entries].reverse() : entry.entries;
          for (const e of list) await applyEntry(e, dir);
          return;
        }
      }
    },
    [],
  );

  const runUndoRedo = useCallback(
    (dir: 'undo' | 'redo') => {
      const from = dir === 'undo' ? journal.current.undo : journal.current.redo;
      const to = dir === 'undo' ? journal.current.redo : journal.current.undo;
      const entry = from.pop();
      if (!entry) return;
      to.push(entry);
      void applyEntry(entry, dir)
        .then(() => invalidate())
        .catch((err) => {
          toast.error(`${dir === 'undo' ? 'Undo' : 'Redo'} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [applyEntry, invalidate],
  );

  // ------------------------------------------------------------- mutations
  const saveTitle = useCallback(
    (row: Row, next: string) => {
      pushUndo({ kind: 'patch', id: row.id, before: { title: row.title ?? '' }, after: { title: next } });
      void updatePromptNode(row.id, { title: next }).catch((err) =>
        toast.error(`Rename failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    [pushUndo],
  );

  const saveBody = useCallback(
    (row: Row, next: string) => {
      pushUndo({ kind: 'patch', id: row.id, before: { body: row.body }, after: { body: next } });
      void updatePromptNode(row.id, { body: next }).catch((err) =>
        toast.error(`Note save failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    [pushUndo],
  );

  const applyMove = useCallback(
    async (assignments: MoveAssignment[] | null) => {
      if (!assignments || assignments.length === 0) return;
      pushUndo({ kind: 'move', before: captureBefore(rows, assignments), after: assignments });
      try {
        await movePromptNodes(assignments);
        invalidate();
      } catch (err) {
        toast.error(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [rows, pushUndo, invalidate],
  );

  const move = useCallback(
    (dir: 'up' | 'down' | 'indent' | 'outdent', id: string) => {
      // Inside a zoom, outdent stops at the zoom root (Workflowy semantics).
      if (dir === 'outdent' && zoom) {
        const row = model.byId.get(id)?.node.row;
        if (row && row.parentId === zoom) return;
      }
      const op =
        dir === 'up' ? moveUpOp : dir === 'down' ? moveDownOp : dir === 'indent' ? indentOp : outdentOp;
      void applyMove(op(model, id));
    },
    [model, applyMove, zoom],
  );

  // Focus hand-off to a row's inline input once it exists (a just-created
  // node's row arrives via the sync refetch).
  const [pendingFocus, setPendingFocus] = useState<{
    id: string;
    caret: number | null;
    /** Optimistic text for the focused input (a merge's joined title) — the
        row model won't carry it until the refetch lands, and the mirror
        effect deliberately skips focused inputs. */
    text?: string;
  } | null>(null);
  const clearPendingFocus = useCallback(() => setPendingFocus(null), []);
  // Which row's note editor is open even while the body is still empty.
  const [noteOpen, setNoteOpen] = useState<string | null>(null);

  const addNode = useCallback(
    async (parentId: string | null) => {
      try {
        const created = await createPromptNode({
          title: '',
          body: '',
          parentId,
          position: appendPosition(model, parentId),
        });
        pushUndo({ kind: 'create', id: created.id });
        invalidate();
        void setSel(created.id);
        setPendingFocus({ id: created.id, caret: null });
      } catch (err) {
        toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [model, pushUndo, invalidate, setSel],
  );

  const addNodeAfter = useCallback(
    async (id: string) => {
      const placement = insertAfterOp(model, id);
      if (!placement) return;
      try {
        if (placement.assignments.length > 0) await movePromptNodes(placement.assignments);
        const created = await createPromptNode({
          title: '',
          body: '',
          parentId: placement.parentId,
          position: placement.position,
        });
        pushUndo({ kind: 'create', id: created.id });
        invalidate();
        void setSel(created.id);
        setPendingFocus({ id: created.id, caret: null });
      } catch (err) {
        toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [model, pushUndo, invalidate, setSel],
  );

  /** Undoable delete (D-004): archive the subtree, offer Undo in the toast. */
  const archiveNode = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      const prev = idx > 0 ? visible[idx - 1].node.row.id : null;
      try {
        const ids = await archivePromptNode(id);
        pushUndo({ kind: 'archive', rootId: id, ids });
        invalidate();
        if (sel === id) void setSel(prev ?? '');
        if (!opts?.silent) {
          toast.success(ids.length > 1 ? `Deleted ${ids.length} items` : 'Deleted', {
            action: {
              label: 'Undo',
              onClick: () => runUndoRedo('undo'),
            },
          });
        }
      } catch (err) {
        toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [visible, sel, pushUndo, invalidate, setSel, runUndoRedo],
  );

  /** Backspace on an empty leaf: remove it, caret to the previous bullet. */
  const deleteEmptyNode = useCallback(
    async (id: string) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      const prev = idx > 0 ? visible[idx - 1].node.row.id : null;
      await archiveNode(id, { silent: true });
      if (prev) setPendingFocus({ id: prev, caret: null });
    },
    [visible, archiveNode],
  );

  /** Backspace at start of a childless bullet: merge it into the bullet above. */
  const mergeUp = useCallback(
    async (id: string, danglingText: string) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      if (idx <= 0) return;
      const node = model.byId.get(id)?.node;
      if (!node || node.children.length > 0) return;
      const prevRow = visible[idx - 1].node.row;
      const mergedTitle = `${prevRow.title ?? ''}${danglingText}`;
      const caret = (prevRow.title ?? '').length;
      const bodyPatch =
        node.row.body.trim().length > 0
          ? {
              body: prevRow.body.trim().length > 0 ? `${prevRow.body}\n\n${node.row.body}` : node.row.body,
            }
          : {};
      try {
        const entries: UndoEntry[] = [];
        entries.push({
          kind: 'patch',
          id: prevRow.id,
          before: { title: prevRow.title ?? '', body: prevRow.body },
          after: { title: mergedTitle, ...bodyPatch },
        });
        await updatePromptNode(prevRow.id, { title: mergedTitle, ...bodyPatch });
        const ids = await archivePromptNode(id);
        entries.push({ kind: 'archive', rootId: id, ids });
        pushUndo({ kind: 'batch', entries });
        invalidate();
        void setSel(prevRow.id);
        setPendingFocus({ id: prevRow.id, caret, text: mergedTitle });
      } catch (err) {
        toast.error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [visible, model, pushUndo, invalidate, setSel],
  );

  const toggleComplete = useCallback(
    (row: Row) => {
      const next = !isCompleted(row);
      pushUndo({ kind: 'patch', id: row.id, before: { completed: !next }, after: { completed: next } });
      void updatePromptNode(row.id, { completed: next })
        .then(() => invalidate())
        .catch(() => {});
    },
    [pushUndo, invalidate],
  );

  const togglePin = useCallback((row: Row) => {
    void updatePromptNode(row.id, { pinned: !row.pinned })
      .then(() => invalidate())
      .catch(() => {});
  }, [invalidate]);

  const toggleCollapse = useCallback((row: Row) => {
    const next = !row.collapsed;
    setCollapseOverlay((s) => ({ ...s, [row.id]: next }));
    void updatePromptNode(row.id, { collapsed: next }).catch(() => {});
  }, []);

  const copyRow = useCallback(async (row: Row, values: Record<string, string>) => {
    const text = fillVariables(row.body, values);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Prompt copied');
      void recordPromptUse(row.id).catch(() => {});
    } catch {
      toast.error('Clipboard unavailable — select the text and copy manually');
    }
  }, []);

  /** ↑/↓ from an inline input: hop the caret to the adjacent visible bullet. */
  const navFrom = useCallback(
    (id: string, delta: 1 | -1) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      if (idx === -1) return;
      const target = visible[Math.max(0, Math.min(visible.length - 1, idx + delta))];
      void setSel(target.node.row.id);
      setPendingFocus({ id: target.node.row.id, caret: null });
    },
    [visible, setSel],
  );

  const zoomIn = useCallback(
    (id: string) => {
      void setZoom(id);
      void setSel(id);
    },
    [setZoom, setSel],
  );

  const zoomOut = useCallback(() => {
    if (!zoom) return;
    const chain = breadcrumbOf(model, zoom);
    const parent = chain.length >= 2 ? chain[chain.length - 2].id : '';
    void setZoom(parent);
  }, [zoom, model, setZoom]);

  // ------------------------------------------------------------------ drag
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragActive, setDragActive] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const dragStartDepth = useRef(0);
  const canDrag = filter.trim().length === 0; // search reorders lie about adjacency

  // Mid-drag the active node's DESCENDANTS leave the list (the subtree
  // travels with the drag) — same rows projectDrop() expects.
  const dragVisible: VisibleRow<Row>[] = useMemo(() => {
    if (!dragActive) return visible;
    const drop = subtreeIds(model, dragActive);
    drop.delete(dragActive);
    return visible.filter((v) => !drop.has(v.node.row.id));
  }, [visible, model, dragActive]);

  const projected = useMemo(() => {
    if (!dragActive || !dragOver) return null;
    return projectDrop(model, dragVisible, dragActive, dragOver, dragDepth, zoom || null);
  }, [model, dragVisible, dragActive, dragOver, dragDepth, zoom]);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const id = String(e.active.id);
    setDragActive(id);
    setDragOver(id);
  }, []);

  const onDragMove = useCallback(
    (e: DragMoveEvent) => {
      if (!dragActive) return;
      const start = dragStartDepth.current;
      setDragDepth(Math.max(0, start + Math.round(e.delta.x / INDENT_PX)));
      setDragOver(e.over ? String(e.over.id) : null);
    },
    [dragActive],
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const active = dragActive;
      const over = e.over ? String(e.over.id) : null;
      const proj =
        active && over ? projectDrop(model, dragVisible, active, over, dragDepth, zoom || null) : null;
      setDragActive(null);
      setDragOver(null);
      if (proj && proj.assignments.length > 0) void applyMove(proj.assignments);
    },
    [dragActive, model, dragVisible, dragDepth, zoom, applyMove],
  );

  const onDragCancel = useCallback(() => {
    setDragActive(null);
    setDragOver(null);
  }, []);

  // Remember the depth the drag started at, for the horizontal depth delta.
  useEffect(() => {
    if (!dragActive) return;
    const v = visible.find((x) => x.node.row.id === dragActive);
    dragStartDepth.current = v?.depth ?? 0;
    setDragDepth(v?.depth ?? 0);
  }, [dragActive, visible]);

  // ------------------------------------------------------------- container
  const outlineRef = useRef<HTMLDivElement>(null);

  const onOutlineKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const mod = e.ctrlKey || e.metaKey;
      // Undo/redo is global to the outline (Workflowy owns text undo too).
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();
        runUndoRedo(e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        runUndoRedo('redo');
        return;
      }
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') {
        return;
      }
      if (visible.length === 0) return;
      const idx = visible.findIndex((v) => v.node.row.id === sel);
      const clamp = (i: number) => Math.max(0, Math.min(visible.length - 1, i));
      if (e.key === 'ArrowDown' && !e.altKey) {
        e.preventDefault();
        void setSel(visible[clamp(idx + 1)].node.row.id);
      } else if (e.key === 'ArrowUp' && !e.altKey) {
        e.preventDefault();
        void setSel(visible[clamp(idx < 0 ? 0 : idx - 1)].node.row.id);
      } else if (sel && e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        move('up', sel);
      } else if (sel && e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        move('down', sel);
      } else if (sel && e.key === 'Tab') {
        e.preventDefault();
        move(e.shiftKey ? 'outdent' : 'indent', sel);
      } else if (sel && ((e.altKey && e.key === 'ArrowRight') || (mod && e.key === ']'))) {
        e.preventDefault();
        zoomIn(sel);
      } else if ((e.altKey && e.key === 'ArrowLeft') || (mod && e.key === '[')) {
        e.preventDefault();
        zoomOut();
      }
    },
    [visible, sel, setSel, move, runUndoRedo, zoomIn, zoomOut],
  );

  const loading = data === undefined;
  const dragRow = dragActive ? (model.byId.get(dragActive)?.node.row ?? null) : null;
  const activeIdx = dragActive ? dragVisible.findIndex((v) => v.node.row.id === dragActive) : -1;
  const overIdx = dragOver ? dragVisible.findIndex((v) => v.node.row.id === dragOver) : -1;
  const dropEdge: 'above' | 'below' = activeIdx !== -1 && overIdx !== -1 && activeIdx < overIdx ? 'below' : 'above';

  return (
    <div className="pc-qp__prompts">
      <div className="pc-qp__outlinecol">
        <div className="pc-qp__toolbar">
          <div className="pc-qp__search">
            <Search size={13} aria-hidden />
            <input
              value={filter}
              onChange={(e) => void setFilter(e.target.value)}
              placeholder="Filter prompts… (try a #tag)"
              aria-label="Filter prompts"
            />
          </div>
          <Tooltip label={hideCompleted ? 'Show completed' : 'Hide completed'}>
            <button
              type="button"
              className={`pc-qp__iconbtn${hideCompleted ? ' on' : ''}`}
              aria-pressed={hideCompleted}
              onClick={() => void setDoneVis(hideCompleted ? 'show' : 'hide')}
            >
              {hideCompleted ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </Tooltip>
          <button
            type="button"
            className="pc-qp__newbtn"
            onClick={() => void addNode(zoom || null)}
          >
            <Plus size={14} aria-hidden /> New prompt
          </button>
        </div>

        {zoom && (
          <div className="pc-qp__crumbbar" aria-label="Zoom breadcrumbs">
            <button type="button" className="pc-qp__crumb" onClick={() => void setZoom('')}>
              <Home size={11} aria-hidden /> Home
            </button>
            {crumbs.slice(0, -1).map((c) => (
              <span key={c.id} className="pc-qp__crumbseg">
                <span className="pc-qp__crumbsep">›</span>
                <button type="button" className="pc-qp__crumb" onClick={() => void setZoom(c.id)}>
                  {displayTitle(c)}
                </button>
              </span>
            ))}
          </div>
        )}

        {pinned.length > 0 && !zoom && (
          <div className="pc-qp__pins" aria-label="Pinned prompts">
            {pinned.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pc-qp__pin${sel === p.id ? ' on' : ''}`}
                onClick={() => zoomIn(p.id)}
              >
                <Pin size={10} aria-hidden /> {displayTitle(p)}
              </button>
            ))}
          </div>
        )}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div
            ref={outlineRef}
            className="pc-qp__outline"
            role="tree"
            aria-label="Saved prompts outline"
            tabIndex={0}
            onKeyDown={onOutlineKeyDown}
          >
            {zoomRow && (
              <div className="pc-qp__zoomhead">
                <input
                  key={zoomRow.id}
                  className="pc-qp__zoomtitle"
                  defaultValue={zoomRow.title ?? ''}
                  placeholder={zoomRow.name}
                  aria-label="Zoomed node title"
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next && next !== displayTitle(zoomRow)) saveTitle(zoomRow, next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      (e.target as HTMLInputElement).blur();
                      void addNode(zoom);
                    } else if (e.key === 'Escape') {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
                {(noteOpen === zoomRow.id || !isFolder(zoomRow)) && (
                  <NodeNote
                    row={zoomRow}
                    autoFocus={pendingFocus?.id === `note:${zoomRow.id}`}
                    onFocused={clearPendingFocus}
                    onOpen={() => setNoteOpen(zoomRow.id)}
                    onSave={(next) => saveBody(zoomRow, next)}
                    onEscape={() => setNoteOpen(null)}
                  />
                )}
              </div>
            )}

            {loading && <div className="pc-qp__empty">Loading prompts…</div>}
            {!loading && visible.length === 0 && (
              <div className="pc-qp__empty">
                {filter
                  ? 'Nothing matches the filter.'
                  : zoom
                    ? 'Nothing inside yet — hit Enter in the title above, or + New prompt.'
                    : 'No saved prompts yet — hit + to create the first one. Prompts saved here also become /slash-commands in agent sessions.'}
              </div>
            )}

            {dragVisible.map(({ node, depth }) => {
              const row = node.row;
              const hasKids = node.children.length > 0;
              const isSel = sel === row.id;
              const showNote = noteOpen === row.id || !isFolder(row);
              const dropLine =
                projected && dragOver === row.id && dragActive !== row.id
                  ? { depth: projected.depth, edge: dropEdge }
                  : null;
              return (
                <div key={row.id} className="pc-qp__rowgroup">
                  <OutlineRow
                    row={row}
                    depth={depth}
                    hasKids={hasKids}
                    selected={isSel}
                    dragging={dragActive === row.id}
                    dropLine={dropLine}
                    canDrag={canDrag}
                    onSelect={() => void setSel(row.id)}
                    onToggleCollapse={() => toggleCollapse(row)}
                    onZoom={() => zoomIn(row.id)}
                  >
                    <NodeTitleInput
                      row={row}
                      hasChildren={hasKids}
                      autoFocus={pendingFocus?.id === row.id}
                      caretTo={pendingFocus?.id === row.id ? pendingFocus.caret : null}
                      presetText={pendingFocus?.id === row.id ? (pendingFocus.text ?? null) : null}
                      onFocused={clearPendingFocus}
                      onFocusRow={() => void setSel(row.id)}
                      onCreateAfter={() => void addNodeAfter(row.id)}
                      onMove={(dir) => {
                        move(dir, row.id);
                        setPendingFocus({ id: row.id, caret: null });
                      }}
                      onNav={(delta) => navFrom(row.id, delta)}
                      onDeleteEmpty={() => void deleteEmptyNode(row.id)}
                      onMergeUp={(text) => void mergeUp(row.id, text)}
                      onOpenNote={() => {
                        setNoteOpen(row.id);
                        setPendingFocus({ id: `note:${row.id}`, caret: null });
                      }}
                      onToggleComplete={() => toggleComplete(row)}
                      onZoomIn={() => zoomIn(row.id)}
                      onZoomOut={zoomOut}
                      onSaveTitle={(next) => saveTitle(row, next)}
                    />
                    <TagChips row={row} onTag={(t) => void setFilter(t)} />
                    {row.pinned && <Pin size={10} className="pc-qp__nodepin" aria-hidden />}
                    {hasKids && row.collapsed && (
                      <span className="pc-qp__count">{node.children.length}</span>
                    )}
                  </OutlineRow>
                  {isSel && (
                    <div
                      className="pc-qp__affordwrap"
                      style={{ paddingLeft: ROW_BASE_PX + depth * INDENT_PX + 40 }}
                    >
                      <NodeAffordances
                        row={row}
                        onCopy={(values) => void copyRow(row, values)}
                        onTogglePin={() => togglePin(row)}
                        onToggleComplete={() => toggleComplete(row)}
                        onArchive={() => void archiveNode(row.id)}
                      />
                    </div>
                  )}
                  {showNote && (
                    <div
                      className="pc-qp__notewrap"
                      style={{ paddingLeft: ROW_BASE_PX + depth * INDENT_PX + 40 }}
                    >
                      <NodeNote
                        row={row}
                        autoFocus={pendingFocus?.id === `note:${row.id}`}
                        onFocused={clearPendingFocus}
                        onOpen={() => setNoteOpen(row.id)}
                        onSave={(next) => saveBody(row, next)}
                        onEscape={() => {
                          setNoteOpen(null);
                          setPendingFocus({ id: row.id, caret: null });
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <DragOverlay dropAnimation={null}>
            {dragRow && (
              <div className="pc-qp__dragghost">
                <span className="pc-qp__bullet" aria-hidden /> {displayTitle(dragRow)}
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <div className="pc-qp__hints">
          <span><kbd>↵</kbd> new</span>
          <span><kbd>⇧↵</kbd> note</span>
          <span><kbd>⌃↵</kbd> done</span>
          <span><kbd>Tab</kbd> indent</span>
          <span><kbd>⌥↑↓</kbd> move</span>
          <span><kbd>⌥→←</kbd> zoom</span>
          <span><kbd>⌃Z</kbd> undo</span>
          <span>drag ● to move · click ● to zoom</span>
        </div>
      </div>
    </div>
  );
}
