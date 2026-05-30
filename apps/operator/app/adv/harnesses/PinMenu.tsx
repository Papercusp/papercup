'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pin } from 'lucide-react';
import { openPanel } from '../../harness/dock/dock-actions';

/**
 * Minimal context menu — opens on row right-click in Features/Issues
 * panels and offers "Pin to new panel". Pinning spawns an `adv:pinned`
 * dock tab whose `itemId` is baked into params; that tab stays put
 * regardless of subsequent `?sel=` changes in the main Detail pane.
 */
type Pos = { x: number; y: number };

export interface PinMenuState {
  pos: Pos;
  itemId: string;
  itemLabel: string;
  harnessSlug: string;
}

interface Props {
  state: PinMenuState | null;
  onClose: () => void;
}

export default function PinMenu({ state, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer the listener install by a tick so the same click that
    // opened the menu doesn't immediately dismiss it.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onDoc);
      window.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc);
    };
  }, [state, onClose]);

  if (!state) return null;

  const pinIt = () => {
    openPanel({
      type: 'adv:pinned',
      title: state.itemLabel,
      params: { itemId: state.itemId, harnessSlug: state.harnessSlug },
    });
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="pc-adv-pin-menu"
      style={{
        position: 'fixed',
        left: state.pos.x,
        top: state.pos.y,
        zIndex: 9000,
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border-strong, rgba(125, 211, 252, 0.32))',
        borderRadius: 6,
        padding: 4,
        minWidth: 200,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
        fontSize: 12,
      }}
    >
      <button
        type="button"
        onClick={pinIt}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          background: 'transparent',
          color: 'var(--fg, #e7f7ff)',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          borderRadius: 4,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklab, var(--accent, #38bdf8), transparent 84%)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <Pin size={12} aria-hidden />
        Pin {state.itemId} to new panel
      </button>
    </div>,
    document.body,
  );
}
