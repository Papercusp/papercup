'use client';

/**
 * ClobberToastStack — Phase 5b P-035 client-side container.
 *
 * Plan: papercusp-dogfood-phase5b-hyperbee-ui-integration-2026-05-24.
 *
 * Subscribes to /api/harness/:slug/clobber-stream via EventSource +
 * renders one <ClobberToast> per recent event. Per-event dismiss +
 * an opt-in cap on the visible stack (default 5).
 *
 * Pure UI consumer: drop into any harness chrome and it manages its
 * own state. Skipped silently when EventSource is unavailable
 * (SSR, ancient browsers).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ClobberToast,
  type ClobberToastEvent,
} from '../ClobberToast';

interface ClobberWireEvent {
  table: string;
  hbKey: string;
  observedAt: number;
  my: { pubkey: string; ts: number };
  theirs: { pubkey: string; ts: number };
}

export interface ClobberToastStackProps {
  slug: string;
  /** Override EventSource impl for tests. */
  EventSourceCtor?: typeof EventSource;
  /** Max visible toasts at once. Default 5; older drop. */
  max?: number;
  /**
   * Override how a contributor pubkey maps to a display name. By
   * default we show the first 8 hex chars. Consumers with a
   * contributor map (Insights, FeatureList) can pass a resolver.
   */
  resolveContributor?: (pubkey: string) => string;
}

function shortPubkey(p: string): string {
  return p.length <= 12 ? p : `${p.slice(0, 8)}…`;
}

function wireToToastEvent(
  raw: ClobberWireEvent,
  resolve: (p: string) => string,
): ClobberToastEvent {
  // Stable id for keying — concat of table + hbKey + observedAt; not
  // globally unique but unique within a session's stack.
  const id = `${raw.table}/${raw.hbKey}/${raw.observedAt}`;
  return {
    id,
    table: raw.table,
    hbKey: raw.hbKey,
    field: undefined,
    byContributor: resolve(raw.theirs.pubkey),
    myValue: undefined,
    theirValue: undefined,
    observedAt: raw.observedAt,
  };
}

export function ClobberToastStack(props: ClobberToastStackProps): ReactNode {
  const [events, setEvents] = useState<ClobberToastEvent[]>([]);
  const max = props.max ?? 5;
  const resolve = props.resolveContributor ?? shortPubkey;

  useEffect(() => {
    if (!props.slug) return;
    const Ctor = props.EventSourceCtor ?? (typeof EventSource !== 'undefined' ? EventSource : null);
    if (!Ctor) return;
    const es = new Ctor(`/api/harness/${encodeURIComponent(props.slug)}/clobber-stream`);
    const onClobber = (msg: MessageEvent) => {
      try {
        const raw = JSON.parse(msg.data) as ClobberWireEvent;
        const ev = wireToToastEvent(raw, resolve);
        setEvents((prev) => {
          // De-dup by id; cap by max from the front.
          const filtered = prev.filter((p) => p.id !== ev.id);
          const next = [...filtered, ev];
          return next.length > max ? next.slice(next.length - max) : next;
        });
      } catch {
        // Malformed payload — drop.
      }
    };
    es.addEventListener('clobber', onClobber as EventListener);
    return () => {
      es.removeEventListener('clobber', onClobber as EventListener);
      es.close();
    };
  }, [props.slug, props.EventSourceCtor, max, resolve]);

  const dismiss = useCallback((id: string) => {
    setEvents((prev) => prev.filter((p) => p.id !== id));
  }, []);

  if (events.length === 0) return null;

  return (
    <div
      data-testid="clobber-toast-stack"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      {events.map((ev) => (
        <div key={ev.id} style={{ pointerEvents: 'auto' }}>
          <ClobberToast event={ev} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
