'use client';

/**
 * Jump-to-item typeahead (P-109).
 *
 * A small combobox above the editor. Type an item ID (P-NNN/D-NNN) or
 * any substring of an item's text; pick a match; the page scrolls the
 * matching `[data-plan-item]` (or `[id="D-NNN"]` heading) into view and
 * pulses .pc-plan-highlight — exactly the affordance the P-NNN refs
 * use, but invoked by keyboard from anywhere on the page.
 *
 * Depends on P-106's data attributes; no separate scroll path of its
 * own. Items + decisions come from plans:get via PlanDetail.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanDecision, PlanItem } from './plans-api';

interface Props {
  items: PlanItem[] | undefined;
  decisions: PlanDecision[] | undefined;
  /** Ref to the editor container — where the data-plan-item nodes live.
   *  Passed as a ref (not .current) because refs don't trigger renders,
   *  so .current would be stale at PlanJumpToItem mount time. */
  scopeRef: React.RefObject<HTMLElement | null>;
}

interface Candidate {
  id: string;
  label: string;
  hint: string;
  kind: 'item' | 'decision';
}

const MAX_HITS = 8;

/**
 * Pure: rank candidates against a query — exact id, then id-prefix, then
 * substring (of id or hint text), capped at MAX_HITS. Exported for tests.
 */
export function rankCandidates(candidates: Candidate[], query: string): Candidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: Candidate[] = [];
  const idPrefix: Candidate[] = [];
  const sub: Candidate[] = [];
  for (const c of candidates) {
    const id = c.id.toLowerCase();
    const hint = c.hint.toLowerCase();
    if (id === q) exact.push(c);
    else if (id.startsWith(q)) idPrefix.push(c);
    else if (id.includes(q) || hint.includes(q)) sub.push(c);
  }
  return [...exact, ...idPrefix, ...sub].slice(0, MAX_HITS);
}

export default function PlanJumpToItem({ items, decisions, scopeRef }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const it of items ?? []) {
      out.push({
        id: it.id,
        label: it.id,
        hint: it.text,
        kind: 'item',
      });
    }
    for (const d of decisions ?? []) {
      out.push({
        id: d.id,
        label: d.id,
        hint: d.title ?? '',
        kind: 'decision',
      });
    }
    return out;
  }, [items, decisions]);

  const hits = useMemo<Candidate[]>(() => rankCandidates(candidates, query), [candidates, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const jumpTo = useCallback(
    (id: string) => {
      const scope = scopeRef.current;
      if (!scope) return;
      let dest: HTMLElement | null = null;
      if (id.startsWith('P-')) {
        dest = scope.querySelector<HTMLElement>(`[data-plan-item="${id}"]`);
      } else {
        dest =
          (scope.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null) ??
          findHeadingByText(scope, id);
      }
      if (!dest) return;
      dest.scrollIntoView({ block: 'center', behavior: 'smooth' });
      dest.classList.add('pc-plan-highlight');
      setTimeout(() => dest?.classList.remove('pc-plan-highlight'), 1500);
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();
    },
    [scopeRef],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setQuery('');
        setOpen(false);
        return;
      }
      if (!hits.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % hits.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + hits.length) % hits.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const hit = hits[active] ?? hits[0];
        if (hit) jumpTo(hit.id);
      }
    },
    [active, hits, jumpTo],
  );

  const noItems = !candidates.length;

  return (
    <div className="pc-jump" data-open={open && hits.length > 0 ? 'true' : 'false'}>
      <input
        ref={inputRef}
        type="text"
        className="pc-jump__input"
        placeholder={noItems ? 'No items in this plan' : 'Jump to P-001, decision, or item text…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
        disabled={noItems}
        aria-label="Jump to item"
        aria-expanded={open && hits.length > 0}
        aria-autocomplete="list"
      />
      {open && hits.length > 0 ? (
        <ul className="pc-jump__hits" role="listbox">
          {hits.map((hit, i) => (
            <li
              key={`${hit.kind}-${hit.id}`}
              className={`pc-jump__hit ${i === active ? 'is-active' : ''}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                jumpTo(hit.id);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={`pc-jump__id pc-jump__id--${hit.kind}`}>{hit.label}</span>
              <span className="pc-jump__hint">{hit.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function findHeadingByText(scope: HTMLElement, id: string): HTMLElement | null {
  for (const h of Array.from(scope.querySelectorAll<HTMLElement>('h3'))) {
    if ((h.textContent ?? '').trim().startsWith(id)) return h;
  }
  return null;
}
