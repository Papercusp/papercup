/**
 * DockNavChevrons — back/forward chevrons in dock chrome.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §16.6
 *
 * Renders next to the AddPanelCatalog button. Walks the tab visit
 * history maintained by useTabVisitHistory. Always rendered; disabled
 * when the respective direction is empty.
 */

'use client';

import { Tooltip } from '@/app/harness/Tooltip';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTabVisitHistory } from './useTabVisitHistory';

interface DockNavChevronsProps {
  className?: string;
}

export function DockNavChevrons({ className }: DockNavChevronsProps) {
  const nav = useTabVisitHistory();
  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        gap: 2,
        alignItems: 'center',
        marginRight: 4,
      }}
      role="group"
      aria-label="Tab history"
    >
      <Tooltip label="Back (Cmd+[)"><button
        type="button"
        onClick={nav.back}
        disabled={!nav.canBack}
        aria-label="Back to previous tab"

        style={btnStyle(nav.canBack)}
      >
        <ChevronLeft size={14} aria-hidden />
      </button></Tooltip>
      <Tooltip label="Forward (Cmd+])"><button
        type="button"
        onClick={nav.forward}
        disabled={!nav.canForward}
        aria-label="Forward to next tab"

        style={btnStyle(nav.canForward)}
      >
        <ChevronRight size={14} aria-hidden />
      </button></Tooltip>
    </div>
  );
}

function btnStyle(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    background: 'var(--bg-2)',
    color: enabled ? 'var(--fg)' : 'var(--fg-mute)',
    border: '1px solid var(--border, #333)',
    borderRadius: 3,
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.5,
  };
}
