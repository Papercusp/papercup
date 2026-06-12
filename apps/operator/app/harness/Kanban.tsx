'use client';

/**
 * Kanban primitives — vendored from Kibo UI (shadcnblocks/kibo,
 * packages/kanban/index.tsx, MIT), ported to this app's design system.
 *
 * Deviations from upstream (all because we are not a shadcn/Tailwind app):
 *  - Tailwind classes → token CSS in ./Kanban.css (var(--bg-*) / var(--border)
 *    / var(--accent) scale; see /internal/docs/design).
 *  - shadcn <Card> / <ScrollArea> → plain divs (native overflow scroll).
 *  - tunnel-rat overlay tunnel → an explicit `overlay(item)` render prop on
 *    KanbanProvider; the DragOverlay renders it (or the item name) for the
 *    active card. Same visual result, one less dependency.
 *  - upstream's onDragOver mutated the item object in place; the column flip
 *    here is immutable.
 *  - drag-cancel clears the active card and notifies via onDragCancel
 *    (upstream leaked activeCardId on cancel).
 *  - KeyboardSensor gets sortableKeyboardCoordinates so keyboard DnD works
 *    inside the sortable lists.
 *
 * Composition (per column):
 *   <KanbanProvider columns data onDataChange overlay>
 *     {(column) => (
 *       <KanbanBoard id={column.id} key={column.id}>
 *         <KanbanHeader>…</KanbanHeader>
 *         <KanbanCards id={column.id}>
 *           {(item) => <KanbanCard key={item.id} {...item}>…</KanbanCard>}
 *         </KanbanCards>
 *       </KanbanBoard>
 *     )}
 *   </KanbanProvider>
 */

import type {
  Announcements,
  DndContextProps,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './Kanban.css';

export type { DragEndEvent } from '@dnd-kit/core';

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

export type KanbanItemProps = {
  id: string;
  name: string;
  column: string;
} & Record<string, unknown>;

export type KanbanColumnProps = {
  id: string;
  name: string;
} & Record<string, unknown>;

type KanbanContextProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = {
  columns: C[];
  data: T[];
  activeCardId: string | null;
};

const KanbanContext = createContext<KanbanContextProps>({
  columns: [],
  data: [],
  activeCardId: null,
});

export type KanbanBoardProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ id, children, className }: KanbanBoardProps) => {
  const { isOver, setNodeRef } = useDroppable({ id });

  return (
    <div
      className={cx('pk-kanban__board', isOver && 'is-over', className)}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
};

export type KanbanCardProps<T extends KanbanItemProps = KanbanItemProps> = T & {
  children?: ReactNode;
  className?: string;
};

export const KanbanCard = <T extends KanbanItemProps = KanbanItemProps>({
  id,
  name,
  children,
  className,
}: KanbanCardProps<T>) => {
  const { attributes, listeners, setNodeRef, transition, transform, isDragging } =
    useSortable({ id });

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  };

  return (
    <div style={style} {...listeners} {...attributes} ref={setNodeRef}>
      <div className={cx('pk-kanban__card', isDragging && 'is-dragging', className)}>
        {children ?? <p className="pk-kanban__card-name">{name}</p>}
      </div>
    </div>
  );
};

export type KanbanCardsProps<T extends KanbanItemProps = KanbanItemProps> = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'id'
> & {
  children: (item: T) => ReactNode;
  id: string;
};

export const KanbanCards = <T extends KanbanItemProps = KanbanItemProps>({
  children,
  className,
  ...props
}: KanbanCardsProps<T>) => {
  const { data } = useContext(KanbanContext) as KanbanContextProps<T>;
  const filteredData = data.filter((item) => item.column === props.id);
  const items = filteredData.map((item) => item.id);

  return (
    <SortableContext items={items}>
      <div className={cx('pk-kanban__cards', className)} {...props}>
        {filteredData.map(children)}
      </div>
    </SortableContext>
  );
};

export type KanbanHeaderProps = HTMLAttributes<HTMLDivElement>;

export const KanbanHeader = ({ className, ...props }: KanbanHeaderProps) => (
  <div className={cx('pk-kanban__header', className)} {...props} />
);

export type KanbanProviderProps<
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
> = Omit<DndContextProps, 'children'> & {
  children: (column: C) => ReactNode;
  className?: string;
  columns: C[];
  data: T[];
  onDataChange?: (data: T[]) => void;
  /** Rendered inside the DragOverlay for the active card; defaults to the
   *  item's name. Pass the same body you render inside KanbanCard so the
   *  floating copy matches the card. */
  overlay?: (item: T) => ReactNode;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
};

export const KanbanProvider = <
  T extends KanbanItemProps = KanbanItemProps,
  C extends KanbanColumnProps = KanbanColumnProps,
>({
  children,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragCancel,
  className,
  columns,
  data,
  onDataChange,
  overlay,
  ...props
}: KanbanProviderProps<T, C>) => {
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const card = data.find((item) => item.id === event.active.id);
    if (card) {
      setActiveCardId(event.active.id as string);
    }
    onDragStart?.(event);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) {
      return;
    }

    const activeItem = data.find((item) => item.id === active.id);
    const overItem = data.find((item) => item.id === over.id);
    if (!activeItem) {
      return;
    }

    const activeColumn = activeItem.column;
    const overColumn =
      overItem?.column ||
      columns.find((col) => col.id === over.id)?.id ||
      columns[0]?.id;

    if (overColumn && activeColumn !== overColumn) {
      let newData = data.map((item) =>
        item.id === active.id ? { ...item, column: overColumn } : item,
      );
      const activeIndex = newData.findIndex((item) => item.id === active.id);
      const overIndex = newData.findIndex((item) => item.id === over.id);
      newData = arrayMove(newData, activeIndex, overIndex >= 0 ? overIndex : activeIndex);
      onDataChange?.(newData);
    }

    onDragOver?.(event);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCardId(null);
    onDragEnd?.(event);

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    let newData = [...data];
    const oldIndex = newData.findIndex((item) => item.id === active.id);
    const newIndex = newData.findIndex((item) => item.id === over.id);
    newData = arrayMove(newData, oldIndex, newIndex);
    onDataChange?.(newData);
  };

  const handleDragCancel: DndContextProps['onDragCancel'] = (event) => {
    setActiveCardId(null);
    onDragCancel?.(event);
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      const { name, column } = data.find((item) => item.id === active.id) ?? {};
      return `Picked up the card "${name}" from the "${column}" column`;
    },
    onDragOver({ active, over }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;
      return `Dragged the card "${name}" over the "${newColumn}" column`;
    },
    onDragEnd({ active, over }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};
      const newColumn = columns.find((column) => column.id === over?.id)?.name;
      return `Dropped the card "${name}" into the "${newColumn}" column`;
    },
    onDragCancel({ active }) {
      const { name } = data.find((item) => item.id === active.id) ?? {};
      return `Cancelled dragging the card "${name}"`;
    },
  };

  const activeItem = activeCardId
    ? data.find((item) => item.id === activeCardId) ?? null
    : null;

  return (
    <KanbanContext.Provider value={{ columns, data, activeCardId }}>
      <DndContext
        accessibility={{ announcements }}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        sensors={sensors}
        {...props}
      >
        <div className={cx('pk-kanban', className)}>
          {columns.map((column) => children(column))}
        </div>
        {typeof window !== 'undefined' &&
          createPortal(
            <DragOverlay>
              {activeItem ? (
                <div className="pk-kanban__card is-overlay">
                  {overlay ? (
                    overlay(activeItem as T)
                  ) : (
                    <p className="pk-kanban__card-name">{activeItem.name}</p>
                  )}
                </div>
              ) : null}
            </DragOverlay>,
            document.body,
          )}
      </DndContext>
    </KanbanContext.Provider>
  );
};
