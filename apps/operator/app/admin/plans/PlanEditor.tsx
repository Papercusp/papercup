'use client';

/**
 * PlanEditor — the decorated markdown surface for one plan.
 *
 * Read mode (default, D-007): static `Vditor.preview` via MarkdownPreview,
 * decorated post-render by `decoratePlanDom` and equipped with a single
 * delegated click listener via `attachPlanRefClickHandler` (P-106).
 *
 * Edit mode: MarkdownEditor with IR-mode Lute renderers registered via
 * `inst.vditor.lute.SetJSRenderers({ Md2VditorIRDOM })` on instance
 * mount (P-202). The P-001 spike confirmed `Md2VditorIRDOM` re-applies
 * on every IR re-spin; `WalkSkipChildren` is the right return value
 * for selective overrides. Edit-mode v1 decorates status pills only —
 * `[data-plan-item]` anchors and prose ref-wrapping stay read-mode-
 * only (D-003's preferred fallback for the IR markers that a full
 * `renderListItem` override would lose).
 *
 * The status-flip popover (P-203) hangs off the delegated click handler
 * via the `onStatusClick` prop — when consumers (PlanDetail) pass one,
 * clicks on `[data-plan-status]` in either mode call back with the
 * target element and current status.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  MarkdownEditor,
  MarkdownPreview,
  type MarkdownEditorToolbar,
} from '@/app/_components/MarkdownEditor';
import type { PlanItem } from './plans-api';
import { attachPlanRefClickHandler, decoratePlanDom } from './plan-renderers';
import {
  attachStatusClickHandler,
  buildPlanIRRenderers,
  readLuteWalk,
} from './plan-renderers-ir';

export interface PlanEditorProps {
  /** Canonical plan markdown (from plans:get). */
  value: string;
  /** Fired on every edit when not read-only. */
  onChange?: (next: string) => void;
  /** Read mode (default, D-007) vs raw-prose Edit mode. */
  readOnly?: boolean;
  /** Plan slug — used by decoration handlers and the toolbar buttons. */
  slug?: string;
  /** Parsed items from plans:get — drives the effective-status badge
   *  and the lookup target for P-NNN ref scrolling (P-106). */
  items?: PlanItem[];
  /** Optional P-203 hook: invoked when a `[data-plan-status]` pill is
   *  clicked in either mode. Receives the target element + the current
   *  status token. The consumer opens the status-flip popover. */
  onStatusClick?: (target: HTMLElement, status: string) => void;
}

const PLAN_TOOLBAR: MarkdownEditorToolbar = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', '|',
  'code', 'inline-code', 'link', 'table', '|',
  'outline', 'preview', 'edit-mode',
  // P-204: append custom { name, icon, tip, hotkey, click } entries.
];

export default function PlanEditor({
  value,
  onChange,
  readOnly = true,
  slug,
  items,
  onStatusClick,
}: PlanEditorProps) {
  void slug;
  // Read-mode delegated click teardown (P-106 ref scroll + optional
  // status click). Edit-mode click teardown (status click only).
  const readDetachRef = useRef<(() => void) | null>(null);
  const editDetachRef = useRef<(() => void) | null>(null);
  // Hold onStatusClick in a ref so registering / re-registering the IR
  // renderers does not depend on the prop identity.
  const onStatusClickRef = useRef(onStatusClick);
  onStatusClickRef.current = onStatusClick;

  const handleParsed = useCallback(
    (root: HTMLElement) => {
      decoratePlanDom(root, items);
      // Vditor.preview re-renders the container's children on every value
      // change — detach the previous handlers before re-attaching so each
      // post-render pass owns exactly one listener per concern.
      readDetachRef.current?.();
      const detachRefs = attachPlanRefClickHandler(root);
      const detachStatus = onStatusClickRef.current
        ? attachStatusClickHandler(root, (t, s) => onStatusClickRef.current?.(t, s))
        : () => {};
      readDetachRef.current = () => {
        detachRefs();
        detachStatus();
      };
    },
    [items],
  );

  const handleInstance = useCallback((inst: any | null) => {
    if (!inst) {
      editDetachRef.current?.();
      editDetachRef.current = null;
      return;
    }
    const walk = readLuteWalk();
    if (!walk) return;
    const renderers = buildPlanIRRenderers(walk);
    try {
      inst.vditor?.lute?.SetJSRenderers({ renderers: { Md2VditorIRDOM: renderers } });
    } catch {
      // If SetJSRenderers throws (older vditor / wrong shape), drop
      // silently — the editor still works without decorations.
      return;
    }
    // Force a re-spin so the renderers apply to the already-rendered
    // initial value. Vditor preserves cursor position across setValue.
    try {
      inst.setValue(inst.getValue());
    } catch {
      /* ignore */
    }
    const irEl = inst.vditor?.ir?.element as HTMLElement | undefined;
    if (irEl) {
      editDetachRef.current?.();
      editDetachRef.current = attachStatusClickHandler(irEl, (t, s) =>
        onStatusClickRef.current?.(t, s),
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      readDetachRef.current?.();
      readDetachRef.current = null;
      editDetachRef.current?.();
      editDetachRef.current = null;
    };
  }, []);

  if (readOnly) {
    return (
      <div className="pc-plan-editor">
        <MarkdownPreview value={value} outline="left" onParsed={handleParsed} />
      </div>
    );
  }

  return (
    <div className="pc-plan-editor">
      <MarkdownEditor
        value={value}
        onChange={onChange}
        mode="ir"
        readOnly={false}
        outline="left"
        toolbar={PLAN_TOOLBAR}
        onInstance={handleInstance}
      />
    </div>
  );
}
