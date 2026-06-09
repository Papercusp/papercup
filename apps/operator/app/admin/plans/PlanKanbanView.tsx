'use client';

/**
 * PlanKanbanView — the Create-tab plan board (P-025; dnd-kit + @papercusp/sync
 * rewrite, replacing the hand-rolled native-HTML5-DnD version).
 *
 * Data: items come LIVE from `useSyncQuery('planItems.byPlan')` — the
 * `harness_plans.items` jsonb projection that `with-plan-lock` rewrites
 * synchronously on every plan write. A drag writes through
 * `useSyncMutate('plans.setStatus', setItemStatus)`, and the set-status route
 * fires `notifySyncInvalidate('planItems.byPlan')`, so the board re-pulls and
 * moves even when ANOTHER agent flips a status. The `items` prop is the
 * `plans:get` snapshot, used as the initial / no-SyncProvider fallback so the
 * board always renders.
 *
 * Bucketing is by the STORED status token (the jsonb `status`); the columns are
 * the four stored tokens, so the issue-block `effectiveStatus` overlay (a
 * derived read-time concept) isn't needed here.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSyncQuery, useSyncMutate } from '@papercusp/sync';
import { setItemStatus, type PlanItem, type ItemStatus } from './plans-api';

const KANBAN_COLS: Array<{ status: ItemStatus; label: string; accent: string }> = [
  { status: 'todo', label: 'To Do', accent: 'var(--fg-mute)' },
  { status: 'wip', label: 'In Progress', accent: 'var(--accent)' },
  { status: 'needs-human', label: 'Needs Human', accent: 'var(--warning)' },
  { status: 'done', label: 'Done', accent: 'var(--success)' },
];
const COL_STATUSES = KANBAN_COLS.map((c) => c.status);
const isColStatus = (s: string): s is ItemStatus => (COL_STATUSES as string[]).includes(s);

/** Normalized shape the board renders — works for both the jsonb rows (which
 *  carry the stored `status` token) and the plans:get `PlanItem` snapshot
 *  (which carries `storedStatus`). */
interface BoardItem {
  id: string;
  text: string;
  status: ItemStatus;
}

function normalize(raw: unknown): BoardItem | null {
  const it = raw as { id?: string; text?: string; status?: string; storedStatus?: string };
  if (!it || typeof it.id !== 'string') return null;
  const status = (it.status ?? it.storedStatus ?? 'todo') as ItemStatus;
  return { id: it.id, text: typeof it.text === 'string' ? it.text : '', status };
}

export interface PlanKanbanViewProps {
  /** Plan slug — the sync-query key and the set-status target. */
  slug: string;
  /** plans:get snapshot — initial render + no-SyncProvider fallback. */
  items: PlanItem[];
  /** Optional nudge so the rest of the detail (badges/counts) refreshes too. */
  onChanged?: () => void;
}

export default function PlanKanbanView({ slug, items, onChanged }: PlanKanbanViewProps) {
  // Live items from the harness_plans.items jsonb projection. Falls back to the
  // plans:get snapshot when no provider is mounted or the first pull is pending.
  const { data } = useSyncQuery<unknown>({ queryName: 'planItems.byPlan', args: { planSlug: slug } });
  const source = data !== undefined ? (data as unknown[]) : (items as unknown[]);

  const server = useMemo(
    () => (Array.isArray(source) ? source.map(normalize).filter((x): x is BoardItem => x !== null) : []),
    [source],
  );

  // Optimistic status overrides — applied instantly on drop, cleared once the
  // live data agrees (the set-status invalidate round-trips back here).
  const [optimistic, setOptimistic] = useState<Record<string, ItemStatus>>({});
  const statusSig = server.map((i) => `${i.id}:${i.status}`).join('|');
  useEffect(() => {
    setOptimistic((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      let changed = false;
      const next = { ...prev };
      for (const i of server) {
        if (next[i.id] === i.status) {
          delete next[i.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // server identity changes each render; key off the stable status signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSig]);

  const view = useMemo(
    () => server.map((it) => (optimistic[it.id] ? { ...it, status: optimistic[it.id]! } : it)),
    [server, optimistic],
  );

  const byStatus = useMemo(() => {
    const m = new Map<ItemStatus, BoardItem[]>();
    for (const s of COL_STATUSES) m.set(s, []);
    for (const it of view) m.get(it.status)?.push(it);
    return m;
  }, [view]);

  const setStatusSync = useSyncMutate('plans.setStatus', setItemStatus);

  const move = async (id: string, to: ItemStatus) => {
    const cur = view.find((i) => i.id === id);
    if (!cur || cur.status === to) return;
    setOptimistic((o) => ({ ...o, [id]: to }));
    try {
      await setStatusSync({ slug, itemId: id, status: to });
      onChanged?.();
    } catch {
      setOptimistic((o) => {
        const n = { ...o };
        delete n[id];
        return n;
      });
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeItem = activeId ? view.find((i) => i.id === activeId) ?? null : null;

  const columnOf = (id: string): ItemStatus | null => {
    if (isColStatus(id)) return id; // dropped onto an empty column
    return view.find((i) => i.id === id)?.status ?? null;
  };

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const to = columnOf(String(over.id));
    if (to) void move(String(active.id), to);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div style={{ display: 'flex', gap: 10, overflow: 'auto', padding: '8px 0', minHeight: 200 }}>
        {KANBAN_COLS.map((col) => (
          <Column
            key={col.status}
            label={col.label}
            accent={col.accent}
            status={col.status}
            items={byStatus.get(col.status) ?? []}
            pending={optimistic}
          />
        ))}
      </div>
      <DragOverlay>{activeItem ? <CardBody item={activeItem} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({
  label,
  accent,
  status,
  items,
  pending,
}: {
  label: string;
  accent: string;
  status: ItemStatus;
  items: BoardItem[];
  pending: Record<string, ItemStatus>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      style={{
        flex: '1 1 0',
        minWidth: 140,
        background: 'var(--surface-2)',
        borderRadius: 6,
        padding: '10px 10px 14px',
        borderTop: `3px solid ${accent}`,
        outline: isOver ? `1px solid ${accent}` : '1px solid transparent',
        transition: 'outline-color 0.12s ease',
      }}
    >
      <div
        style={{
          fontSize: '0.72em',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: accent,
          marginBottom: 8,
        }}
      >
        {label}{' '}
        <span style={{ fontWeight: 400, color: 'var(--fg-mute)' }}>({items.length})</span>
      </div>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <SortableCard key={item.id} item={item} saving={!!pending[item.id]} />
        ))}
      </SortableContext>
    </div>
  );
}

function SortableCard({ item, saving }: { item: BoardItem; saving: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : saving ? 0.6 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <CardBody item={item} />
    </div>
  );
}

/** The card's visual content, shared by the in-column card and the DragOverlay. */
function CardBody({ item, dragging = false }: { item: BoardItem; dragging?: boolean }) {
  return (
    <div
      style={{
        background: 'var(--surface-1)',
        borderRadius: 4,
        padding: '6px 8px',
        marginBottom: 6,
        cursor: 'grab',
        fontSize: '0.8em',
        border: '1px solid var(--border)',
        boxShadow: dragging ? '0 8px 20px rgba(0,0,0,0.45)' : 'none',
      }}
    >
      <code style={{ color: 'var(--fg-mute)', fontSize: '0.85em', display: 'block', marginBottom: 2 }}>
        {item.id}
      </code>
      <span style={{ lineHeight: 1.4 }}>{item.text.replace(/^`[^`]+`\s*/, '').slice(0, 120)}</span>
    </div>
  );
}
