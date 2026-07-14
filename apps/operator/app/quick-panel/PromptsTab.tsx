'use client';

/**
 * PromptsTab — the Quick Panel's default tab: a Workflowy-style saved-prompts
 * outline (quick-panel-saved-prompts-2026-07-13 P-006).
 *
 * Model (D-003): every `harness_shared.saved_prompts` row is both an outline
 * node AND a prompt — the title is the bullet, the body is the prompt text; an
 * empty body marks a pure folder (never materialized as a slash command). The
 * outline is the ORGANIZER: infinite nesting, collapse, keyboard indent/outdent
 * and reorder, a pinned strip, and a live filter. Prompts double as agent
 * slash commands via the existing launch-time materialization, so everything
 * saved here shows up as /name in Claude/Codex/OMP sessions.
 *
 * Data: reads via useSyncQuery('savedPrompts.byScope') — agent-side edits
 * (saved_prompts tools / direct writes) push into an open panel via the
 * migration-598 change-notify trigger. Writes go through the WebView-hardened
 * client helpers (CORS-simple POSTs, D-010) and rely on the server's
 * notifySyncInvalidate for refetch, plus an explicit invalidate() for
 * immediacy.
 *
 * Keyboard (outline focused): ↑/↓ select · Alt+↑/↓ move · Tab/Shift+Tab
 * indent/outdent · Enter edits the body.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  CornerDownRight,
  FolderPlus,
  IndentDecrease,
  IndentIncrease,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import {
  appendPosition,
  buildPromptTree,
  displayTitle,
  extractVariables,
  fillVariables,
  indent as indentOp,
  insertAfter as insertAfterOp,
  isFolder,
  moveDown as moveDownOp,
  moveUp as moveUpOp,
  outdent as outdentOp,
  visibleRows,
  type MoveAssignment,
  type PromptNodeFields,
} from '@papercusp/operator-core/lib/saved-prompts-tree';
import {
  createPromptNode,
  deletePromptNode,
  movePromptNodes,
  recordPromptUse,
  updatePromptNode,
  type SavedPrompt,
} from '@papercusp/operator-core/lib/saved-prompts-client';
import { Button } from '@/app/harness/Button';
import { Tooltip } from '@/app/harness/Tooltip';
import { TextArea, TextInput } from '@/app/harness/TextInput';
import { useDebouncedSave } from '@/app/harness/useDebouncedSave';

/** Panel v1 operates on the WORKSPACE scope (D-003); harness prompts stay in harness settings. */
const SCOPE_ARGS = {} as const;

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

/** Render a body with `{{variables}}` highlighted (read-only preview). */
function VarPreview({ body }: { body: string }) {
  const parts = body.split(/(\{\{\s*[^{}]+?\s*\}\})/g);
  return (
    <pre className="pc-qp__varpreview">
      {parts.map((p, i) =>
        /^\{\{\s*[^{}]+?\s*\}\}$/.test(p) ? (
          <span key={i} className="pc-qp__var">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </pre>
  );
}

/** The editable detail pane for the selected node. Keyed by node id (remounts on selection). */
function PreviewPane({
  row,
  crumb,
  onDelete,
  onAddChild,
  canMove,
  onMove,
}: {
  row: SavedPrompt;
  crumb: string[];
  onDelete: () => void;
  onAddChild: () => void;
  canMove: { up: boolean; down: boolean; indent: boolean; outdent: boolean };
  onMove: (dir: 'up' | 'down' | 'indent' | 'outdent') => void;
}) {
  const [title, setTitle] = useState(displayTitle(row));
  const [body, setBody] = useState(row.body);
  const [editingBody, setEditingBody] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  useDebouncedSave(title, async (v) => {
    const next = v.trim();
    if (next && next !== displayTitle(row)) await updatePromptNode(row.id, { title: next });
  });
  useDebouncedSave(body, async (v) => {
    if (v !== row.body) await updatePromptNode(row.id, { body: v });
  });

  const vars = useMemo(() => extractVariables(body), [body]);

  const copy = useCallback(async () => {
    const text = fillVariables(body, varValues);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Prompt copied');
      void recordPromptUse(row.id).catch(() => {});
    } catch {
      toast.error('Clipboard unavailable — select the text and copy manually');
    }
  }, [body, varValues, row.id]);

  const folder = isFolder({ body });

  return (
    <div className="pc-qp__preview">
      <div className="pc-qp__crumbs">
        {crumb.length > 0 ? crumb.join(' › ') + ' ›' : 'top level'}
      </div>
      <div className="pc-qp__titlerow">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Prompt title"
          className="pc-qp__titleinput"
        />
        <Tooltip label={row.pinned ? 'Unpin' : 'Pin to the top strip'}>
          <button
            type="button"
            className={`pc-qp__iconbtn${row.pinned ? ' on' : ''}`}
            aria-pressed={row.pinned}
            onClick={() => void updatePromptNode(row.id, { pinned: !row.pinned })}
          >
            {row.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        </Tooltip>
      </div>
      <div className="pc-qp__meta">
        {!folder && <code className="pc-qp__name">/{row.name}</code>}
        {folder && <span>folder</span>}
        {row.usageCount > 0 && <span>used {row.usageCount}×</span>}
        {relTime(row.lastUsedAt) && <span>last {relTime(row.lastUsedAt)}</span>}
      </div>

      {editingBody ? (
        <TextArea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => setEditingBody(false)}
          aria-label="Prompt body"
          className="pc-qp__bodyeditor"
          autoFocus
          placeholder="Prompt text… ({{variables}} are filled at use time; leave empty for a folder)"
        />
      ) : (
        <button
          type="button"
          className="pc-qp__bodyview"
          onClick={() => setEditingBody(true)}
          aria-label="Edit prompt body"
        >
          {body.trim().length > 0 ? (
            <VarPreview body={body} />
          ) : (
            <span className="pc-qp__bodyempty">
              Folder node — click to add prompt text and make it a usable prompt.
            </span>
          )}
        </button>
      )}

      {vars.length > 0 && (
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
        </div>
      )}

      <div className="pc-qp__actions">
        {!folder && (
          <Button variant="primary" onClick={() => void copy()}>
            <Copy size={13} /> Copy
          </Button>
        )}
        <Button onClick={onAddChild}>
          <CornerDownRight size={13} /> New child
        </Button>
        <span className="pc-qp__movegroup" role="group" aria-label="Move node">
          <Tooltip label="Move up (Alt+↑)">
            <button type="button" className="pc-qp__iconbtn" disabled={!canMove.up} onClick={() => onMove('up')}>
              <ArrowUp size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Move down (Alt+↓)">
            <button type="button" className="pc-qp__iconbtn" disabled={!canMove.down} onClick={() => onMove('down')}>
              <ArrowDown size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Indent (Tab)">
            <button type="button" className="pc-qp__iconbtn" disabled={!canMove.indent} onClick={() => onMove('indent')}>
              <IndentIncrease size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Outdent (Shift+Tab)">
            <button type="button" className="pc-qp__iconbtn" disabled={!canMove.outdent} onClick={() => onMove('outdent')}>
              <IndentDecrease size={13} />
            </button>
          </Tooltip>
        </span>
        <span className="pc-qp__spacer" />
        {confirmDelete ? (
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 size={13} /> Delete subtree?
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline-editable node title — the Workflowy behavior: the outline text IS the
 * editor. Typing saves on debounce; while the input is NOT focused it mirrors
 * the server row (so a rename from the preview pane shows up), and while
 * focused the local draft wins (so the sync refetch can't clobber typing).
 *
 * Keys (Workflowy grammar): Enter → new node below · Tab/Shift+Tab
 * indent/outdent · Alt+↑/↓ move · ↑/↓ hop to the prev/next bullet ·
 * Backspace on an EMPTY leaf deletes it · Escape returns focus to the tree.
 */
function NodeTitleInput({
  row,
  hasChildren,
  autoFocus,
  onFocused,
  onFocusRow,
  onCreateAfter,
  onMove,
  onNav,
  onDeleteEmpty,
}: {
  row: SavedPrompt;
  hasChildren: boolean;
  autoFocus: boolean;
  onFocused: () => void;
  onFocusRow: () => void;
  onCreateAfter: () => void;
  onMove: (dir: 'up' | 'down' | 'indent' | 'outdent') => void;
  onNav: (delta: 1 | -1) => void;
  onDeleteEmpty: () => void;
}) {
  const [text, setText] = useState(row.title ?? '');
  const focusedRef = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  // Mirror external renames while not editing (see the component docstring).
  useEffect(() => {
    if (!focusedRef.current) setText(row.title ?? '');
  }, [row.title]);

  const { flush } = useDebouncedSave(text, async (v) => {
    const next = v.trim();
    if (!next || next === displayTitle(row)) return;
    await updatePromptNode(row.id, { title: next });
  });

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      const end = ref.current.value.length;
      ref.current.setSelectionRange(end, end);
      onFocused();
    }
  }, [autoFocus, onFocused]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void flush().then(onCreateAfter);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        onMove(e.shiftKey ? 'outdent' : 'indent');
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        onMove(e.key === 'ArrowUp' ? 'up' : 'down');
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        onNav(e.key === 'ArrowDown' ? 1 : -1);
      } else if (
        e.key === 'Backspace' &&
        text.length === 0 &&
        !hasChildren &&
        isFolder(row)
      ) {
        // Workflowy: backspace on an empty bullet removes it. Only a truly
        // empty LEAF (no title text, no body, no children) qualifies — nothing
        // with content can be deleted from the keyboard by accident.
        e.preventDefault();
        onDeleteEmpty();
      } else if (e.key === 'Escape') {
        ref.current?.blur();
      }
    },
    [flush, onCreateAfter, onMove, onNav, onDeleteEmpty, text, hasChildren, row],
  );

  return (
    <input
      ref={ref}
      className="pc-qp__nodetitle"
      value={text}
      placeholder={isFolder(row) && !hasChildren ? 'New prompt…' : row.name}
      aria-label={`Title of ${displayTitle(row)}`}
      onChange={(e) => setText(e.target.value)}
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

export default function PromptsTab() {
  const { data, invalidate } = useSyncQuery<SavedPrompt>({
    queryName: 'savedPrompts.byScope',
    args: SCOPE_ARGS,
  });

  // Optimistic collapse overlay — a caret toggle shows instantly while the
  // write + sync round-trip settles (the overlay converges with the server).
  const [collapseOverlay, setCollapseOverlay] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => {
    const base = (data ?? []) as unknown as (SavedPrompt & PromptNodeFields)[];
    return base.map((r) =>
      collapseOverlay[r.id] !== undefined ? { ...r, collapsed: collapseOverlay[r.id] } : r,
    );
  }, [data, collapseOverlay]);

  const [filter, setFilter] = useState('');
  const [sel, setSel] = useQueryState('sel', parseAsString.withDefault(''));

  const model = useMemo(() => buildPromptTree(rows), [rows]);
  const visible = useMemo(() => visibleRows(model, filter), [model, filter]);
  const selRow = useMemo(() => rows.find((r) => r.id === sel) ?? null, [rows, sel]);
  const pinned = useMemo(() => rows.filter((r) => r.pinned), [rows]);

  const outlineRef = useRef<HTMLDivElement>(null);

  const crumb = useMemo(() => {
    if (!selRow) return [];
    const parts: string[] = [];
    let cur = model.byId.get(selRow.id)?.parent ?? null;
    while (cur) {
      parts.unshift(displayTitle(cur.row));
      cur = model.byId.get(cur.row.id)?.parent ?? null;
    }
    return parts;
  }, [model, selRow]);

  const applyMove = useCallback(
    async (assignments: MoveAssignment[] | null) => {
      if (!assignments || assignments.length === 0) return;
      try {
        await movePromptNodes(assignments);
        invalidate();
      } catch (err) {
        toast.error(`Move failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [invalidate],
  );

  const move = useCallback(
    (dir: 'up' | 'down' | 'indent' | 'outdent', id: string) => {
      const op =
        dir === 'up' ? moveUpOp : dir === 'down' ? moveDownOp : dir === 'indent' ? indentOp : outdentOp;
      void applyMove(op(model, id));
    },
    [model, applyMove],
  );

  // The node whose inline title input should grab focus once it exists in the
  // outline (a just-created node's row arrives via the sync refetch, so the
  // focus is deferred until its input mounts — Workflowy's type-immediately).
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const clearPendingFocus = useCallback(() => setPendingFocus(null), []);

  const addNode = useCallback(
    async (parentId: string | null) => {
      try {
        // Empty title (Workflowy: a new bullet is blank and you just type);
        // the server derives a placeholder slug until the first rename.
        const created = await createPromptNode({
          title: '',
          body: '',
          parentId,
          position: appendPosition(model, parentId),
        });
        invalidate();
        void setSel(created.id);
        setPendingFocus(created.id);
      } catch (err) {
        toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [model, invalidate, setSel],
  );

  /** Enter on a node: create the next bullet (sibling — or first child when
   *  the node is expanded with children) and move typing focus into it. */
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
        invalidate();
        void setSel(created.id);
        setPendingFocus(created.id);
      } catch (err) {
        toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [model, invalidate, setSel],
  );

  /** Backspace on an empty leaf: remove it and put the caret on the previous bullet. */
  const deleteEmptyNode = useCallback(
    async (id: string) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      const prev = idx > 0 ? visible[idx - 1].node.row.id : null;
      try {
        await deletePromptNode(id);
        invalidate();
        void setSel(prev ?? '');
        if (prev) setPendingFocus(prev);
      } catch (err) {
        toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [visible, invalidate, setSel],
  );

  /** ↑/↓ from an inline input: hop the caret to the adjacent visible bullet. */
  const navFrom = useCallback(
    (id: string, delta: 1 | -1) => {
      const idx = visible.findIndex((v) => v.node.row.id === id);
      if (idx === -1) return;
      const target = visible[Math.max(0, Math.min(visible.length - 1, idx + delta))];
      void setSel(target.node.row.id);
      setPendingFocus(target.node.row.id);
    },
    [visible, setSel],
  );

  const removeNode = useCallback(async () => {
    if (!selRow) return;
    try {
      await deletePromptNode(selRow.id);
      invalidate();
      void setSel('');
      toast.success('Deleted');
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selRow, invalidate, setSel]);

  const toggleCollapse = useCallback(
    (row: SavedPrompt) => {
      const next = !row.collapsed;
      setCollapseOverlay((s) => ({ ...s, [row.id]: next }));
      void updatePromptNode(row.id, { collapsed: next }).catch(() => {});
    },
    [],
  );

  // NOTE deliberately NO "clear sel when the row is missing" effect: right
  // after a create, `sel` points at the new node BEFORE the sync refetch
  // delivers it, and such a guard raced the refetch and wiped the selection
  // (found live, 2026-07-13). A sel that never resolves is harmless — the
  // preview column just shows its empty state. Deletes clear sel explicitly.

  const onOutlineKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // The inline title inputs own their key handling (Workflowy grammar);
      // this container-level fallback is only for focus on the tree itself.
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
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
      }
    },
    [visible, sel, setSel, move],
  );

  const loading = data === undefined;

  return (
    <div className="pc-qp__prompts">
      <div className="pc-qp__outlinecol">
        <div className="pc-qp__toolbar">
          <div className="pc-qp__search">
            <Search size={13} aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter prompts…"
              aria-label="Filter prompts"
            />
          </div>
          {/* Prominent labeled create button (owner ask 2026-07-14: the old
              bare-icon button read as an unclickable dot). */}
          <button
            type="button"
            className="pc-qp__newbtn"
            onClick={() => void addNode(null)}
          >
            <Plus size={14} aria-hidden /> New prompt
          </button>
        </div>

        {pinned.length > 0 && (
          <div className="pc-qp__pins" aria-label="Pinned prompts">
            {pinned.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pc-qp__pin${sel === p.id ? ' on' : ''}`}
                onClick={() => void setSel(p.id)}
              >
                <Pin size={10} aria-hidden /> {displayTitle(p)}
              </button>
            ))}
          </div>
        )}

        <div
          ref={outlineRef}
          className="pc-qp__outline"
          role="tree"
          aria-label="Saved prompts outline"
          tabIndex={0}
          onKeyDown={onOutlineKeyDown}
        >
          {loading && <div className="pc-qp__empty">Loading prompts…</div>}
          {!loading && visible.length === 0 && (
            <div className="pc-qp__empty">
              {filter
                ? 'Nothing matches the filter.'
                : 'No saved prompts yet — hit + to create the first one. Prompts saved here also become /slash-commands in agent sessions.'}
            </div>
          )}
          {visible.map(({ node, depth }) => {
            const row = node.row as SavedPrompt;
            const hasKids = node.children.length > 0;
            const folder = isFolder(row);
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-selected={sel === row.id}
                aria-expanded={hasKids ? !row.collapsed : undefined}
                className={`pc-qp__node${sel === row.id ? ' sel' : ''}${folder ? ' folder' : ''}`}
                style={{ paddingLeft: 8 + depth * 18 }}
                onClick={() => void setSel(row.id)}
              >
                <button
                  type="button"
                  className={`pc-qp__caret${hasKids ? '' : ' leaf'}${row.collapsed ? ' closed' : ''}`}
                  aria-label={row.collapsed ? 'Expand' : 'Collapse'}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasKids) toggleCollapse(row);
                  }}
                >
                  <ChevronRight size={11} />
                </button>
                <span className="pc-qp__bullet" aria-hidden />
                <NodeTitleInput
                  row={row}
                  hasChildren={hasKids}
                  autoFocus={pendingFocus === row.id}
                  onFocused={clearPendingFocus}
                  onFocusRow={() => void setSel(row.id)}
                  onCreateAfter={() => void addNodeAfter(row.id)}
                  onMove={(dir) => {
                    move(dir, row.id);
                    setPendingFocus(row.id);
                  }}
                  onNav={(delta) => navFrom(row.id, delta)}
                  onDeleteEmpty={() => void deleteEmptyNode(row.id)}
                />
                {row.pinned && <Pin size={10} className="pc-qp__nodepin" aria-hidden />}
                {hasKids && row.collapsed && (
                  <span className="pc-qp__count">{node.children.length}</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="pc-qp__hints">
          <span><kbd>↵</kbd> new</span>
          <span><kbd>↑↓</kbd> select</span>
          <span><kbd>⌥↑↓</kbd> move</span>
          <span><kbd>Tab</kbd>/<kbd>⇧Tab</kbd> indent</span>
          <span><kbd>⌫</kbd> delete empty</span>
        </div>
      </div>

      <div className="pc-qp__previewcol">
        {selRow ? (
          <PreviewPane
            key={selRow.id}
            row={selRow}
            crumb={crumb}
            onDelete={() => void removeNode()}
            onAddChild={() => void addNode(selRow.id)}
            canMove={{
              up: moveUpOp(model, selRow.id) !== null,
              down: moveDownOp(model, selRow.id) !== null,
              indent: indentOp(model, selRow.id) !== null,
              outdent: outdentOp(model, selRow.id) !== null,
            }}
            onMove={(dir) => move(dir, selRow.id)}
          />
        ) : (
          <div className="pc-qp__empty pc-qp__previewempty">
            <FolderPlus size={18} aria-hidden />
            <p>Select a prompt to preview and edit it — or create one with +.</p>
            <p className="pc-qp__emptysub">
              Every node is both a folder and a prompt: give it children to organize, give it a
              body to make it usable. Non-empty prompts become <code>/slash-commands</code> in
              agent sessions automatically.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
