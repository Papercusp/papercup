// @vitest-environment jsdom
//
// PlanJumpToItem — the jump-to-item typeahead (P-109). Genuine logic: the hit
// ranking (exact id > id-prefix > substring of id/text, capped at 8), the
// keyboard nav (Arrow/Enter/Escape), and the jump → scrollIntoView + highlight
// pulse against a scopeRef DOM. No external deps beyond plans-api *types*, so
// the component renders directly with fixture items/decisions.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import type { PlanItem, PlanDecision } from './plans-api';
import PlanJumpToItem, { rankCandidates } from './PlanJumpToItem';

type Candidate = { id: string; label: string; hint: string; kind: 'item' | 'decision' };
function cand(id: string, hint: string, kind: 'item' | 'decision' = 'item'): Candidate {
  return { id, label: id, hint, kind };
}

afterEach(cleanup);

function item(id: string, text: string): PlanItem {
  return { id, text, storedStatus: 'todo', effectiveStatus: 'todo' } as PlanItem;
}
function decision(id: string, title: string): PlanDecision {
  return { id, title };
}

function setup(over: { items?: PlanItem[]; decisions?: PlanDecision[]; scope?: HTMLElement } = {}) {
  const ref = over.scope ? { current: over.scope } : createRef<HTMLElement>();
  render(<PlanJumpToItem items={over.items} decisions={over.decisions} scopeRef={ref} />);
  return ref;
}

function input() {
  return screen.getByLabelText('Jump to item') as HTMLInputElement;
}
function options() {
  return Array.from(document.querySelectorAll('.pc-jump__hit'));
}

describe('<PlanJumpToItem /> empty state', () => {
  it('disables the input and shows the no-items placeholder when there are no candidates', () => {
    setup({ items: [], decisions: [] });
    const el = input();
    expect(el.disabled).toBe(true);
    expect(el.placeholder).toMatch(/no items in this plan/i);
  });
});

describe('rankCandidates (pure)', () => {
  it('returns no hits for an empty / whitespace query', () => {
    expect(rankCandidates([cand('P-001', 'first')], '')).toEqual([]);
    expect(rankCandidates([cand('P-001', 'first')], '   ')).toEqual([]);
  });

  it('ranks an exact id match before a prefix match before a substring match', () => {
    const out = rankCandidates(
      [cand('P-100', 'hundred'), cand('P-1', 'exact'), cand('P-12', 'prefix')],
      'P-1',
    );
    const ids = out.map((c) => c.id);
    // Exact "P-1" first, then prefix matches "P-12" / "P-100".
    expect(ids[0]).toBe('P-1');
    expect(ids).toContain('P-12');
    expect(ids).toContain('P-100');
  });

  it('matches on the hint text substring, not just the id', () => {
    const out = rankCandidates(
      [cand('P-001', 'refactor the parser'), cand('P-002', 'unrelated')],
      'parser',
    );
    expect(out.map((c) => c.id)).toEqual(['P-001']);
  });

  it('is case-insensitive on both id and hint', () => {
    const out = rankCandidates([cand('P-001', 'The Parser')], 'PARSER');
    expect(out.map((c) => c.id)).toEqual(['P-001']);
  });

  it('caps the hit list at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => cand(`P-${i + 1}`, 'match here'));
    expect(rankCandidates(many, 'match')).toHaveLength(8);
  });
});

describe('<PlanJumpToItem /> dropdown', () => {
  it('renders decision candidates with the decision kind class', () => {
    setup({ items: [], decisions: [decision('D-003', 'pick the store')] });
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'D-003' } });
    expect(options()[0]?.querySelector('.pc-jump__id--decision')).toBeTruthy();
  });
});

describe('<PlanJumpToItem /> keyboard + jump', () => {
  it('jumps to a P- item via Enter, scrolling + pulsing the target', () => {
    const scope = document.createElement('div');
    const target = document.createElement('div');
    target.setAttribute('data-plan-item', 'P-007');
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;
    scope.appendChild(target);
    setup({ items: [item('P-007', 'the target')], scope });

    fireEvent.change(input(), { target: { value: 'P-007' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(scrollSpy).toHaveBeenCalledOnce();
    expect(target.classList.contains('pc-plan-highlight')).toBe(true);
    // After a jump, the query resets (the dropdown closes).
    expect(input().value).toBe('');
  });

  it('clears the query on Escape', () => {
    setup({ items: [item('P-001', 'x')] });
    fireEvent.change(input(), { target: { value: 'P-0' } });
    expect(input().value).toBe('P-0');
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(input().value).toBe('');
  });

  it('moves the active option with ArrowDown (wrapping at the end)', () => {
    setup({
      items: [item('P-001', 'match a'), item('P-002', 'match b')],
    });
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'match' } });
    // First option is active by default.
    expect(options()[0]?.classList.contains('is-active')).toBe(true);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[1]?.classList.contains('is-active')).toBe(true);
  });
});
