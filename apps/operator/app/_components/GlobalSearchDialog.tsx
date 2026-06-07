'use client';

/**
 * Global content search (Discord-parity Mod+Shift+F — discord-shortcuts
 * 2026-06-06, deferred-items pass).
 *
 * A thin overlay on the operator's prose search: POSTs the public
 * `/api/agent-tools/search/fulltext` endpoint (BM25 over plans / docs /
 * turns / decisions / escalations, cross-encoder reranked server-side)
 * and lists the hits. v1 is read-only — hits show source · harness ·
 * highlighted excerpt; per-source deep-link navigation is a follow-up
 * once the source→route mapping is settled.
 *
 * State lives in nuqs (`?gsearch=1&gq=…`) per the repo rule — the overlay
 * is deep-linkable, survives reload, and agent-driveable. Only the fetch
 * is debounced.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useShortcutAction } from '../../lib/hotkeys';

export interface FulltextHit {
  source: string;
  source_id: string;
  harness_slug?: string;
  excerpt: string;
  highlight?: string;
  rank?: number;
}

/**
 * ts_headline marks matches with `<b>…</b>`. Render ONLY that marker as
 * <mark>; everything else is emitted as text nodes (XSS-safe — no
 * dangerouslySetInnerHTML).
 */
export function renderHighlight(s: string): ReactNode[] {
  const parts = s.split(/<b>(.*?)<\/b>/g);
  return parts
    .map((part, i) =>
      part ? (
        i % 2 === 1 ? (
          <mark key={i} className="pc-gsearch__mark">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      ) : null,
    )
    .filter(Boolean) as ReactNode[];
}

export default function GlobalSearchDialog() {
  const [open, setOpen] = useQueryState('gsearch', parseAsBoolean.withDefault(false));
  const [query, setQuery] = useQueryState('gq', parseAsString.withDefault(''));
  const [hits, setHits] = useState<FulltextHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useShortcutAction('search.global', () => {
    void setOpen(!open);
  }, { enableOnFormTags: ['INPUT', 'TEXTAREA'] });

  // Debounced fetch while the overlay is open. <2 chars clears results
  // rather than spamming the endpoint with single letters.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => {
      setBusy(true);
      setError(null);
      fetch('/api/agent-tools/search/fulltext', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: 10 }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((body) => {
          const parsed = JSON.parse(body?.content?.[0]?.text ?? '{}');
          setHits(Array.isArray(parsed.results) ? (parsed.results as FulltextHit[]) : []);
        })
        .catch((e) => setError(String((e as Error)?.message ?? e)))
        .finally(() => setBusy(false));
    }, 300);
    return () => clearTimeout(t);
  }, [open, query]);

  // Focus the input when the overlay opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) void setOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="kbd-cheat-overlay" />
        <Dialog.Content
          aria-label="Search everywhere"
          style={{
            position: 'fixed',
            top: '12vh',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(640px, 92vw)',
            maxHeight: '70vh',
            overflow: 'hidden auto',
            background: 'var(--pc-surface, #16181d)',
            color: 'var(--pc-text, #e5e7eb)',
            border: '1px solid var(--pc-border, #2a2e37)',
            borderRadius: 10,
            padding: 16,
            zIndex: 1000,
            boxShadow: '0 18px 50px rgba(0,0,0,.5)',
          }}
        >
          <Dialog.Title style={{ fontSize: 13, opacity: 0.7, margin: '0 0 8px' }}>
            Search everywhere
          </Dialog.Title>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => void setQuery(e.target.value)}
            placeholder="Search plans, docs, turns, decisions…"
            aria-label="Search query"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--pc-border, #2a2e37)',
              background: 'var(--pc-surface-2, #0f1115)',
              color: 'inherit',
              fontSize: 14,
            }}
          />
          <div style={{ marginTop: 10 }}>
            {busy && <div style={{ fontSize: 12, opacity: 0.6 }}>Searching…</div>}
            {error && (
              <div role="alert" style={{ fontSize: 12, color: '#f87171' }}>
                Search failed: {error}
              </div>
            )}
            {hits && hits.length === 0 && !busy && (
              <div style={{ fontSize: 12, opacity: 0.6 }}>No results.</div>
            )}
            {hits && hits.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {hits.map((h, i) => (
                  <li
                    key={`${h.source}:${h.source_id}:${i}`}
                    data-testid="gsearch-hit"
                    style={{
                      padding: '8px 6px',
                      borderBottom: '1px solid var(--pc-border, #232730)',
                    }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', gap: 8 }}>
                      <span>{h.source}</span>
                      {h.harness_slug && <span>· {h.harness_slug}</span>}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 2 }}>
                      {renderHighlight(h.highlight || h.excerpt || '')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
