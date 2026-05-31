import { describe, it, expect } from 'vitest';
import {
  importanceRank,
  sortByImportance,
  severityToImportance,
  type AttentionItem,
} from './types';
import {
  planItemToAttention,
  coordEscalationToAttention,
  coordMessageToAttention,
  smokeFailToAttention,
  planReviewToAttention,
} from './adapters';

describe('importance helpers', () => {
  it('ranks urgent→low ascending', () => {
    expect(importanceRank('urgent')).toBeLessThan(importanceRank('high'));
    expect(importanceRank('high')).toBeLessThan(importanceRank('normal'));
    expect(importanceRank('normal')).toBeLessThan(importanceRank('low'));
  });

  it('sortByImportance is stable within a level', () => {
    const items = [
      { id: 'a', importance: 'normal' as const },
      { id: 'b', importance: 'urgent' as const },
      { id: 'c', importance: 'normal' as const },
      { id: 'd', importance: 'high' as const },
    ];
    expect(sortByImportance(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('maps severity to importance (blocker→urgent, question→high, advisory→low)', () => {
    expect(severityToImportance('blocker')).toBe('urgent');
    expect(severityToImportance('question')).toBe('high');
    expect(severityToImportance('advisory')).toBe('low');
  });
});

describe('planItemToAttention', () => {
  const base = {
    slug: 'p-2026-05-31',
    harnessSlug: 'papercup',
    id: 'P-007',
    text: 'Sign off before ship',
    storedStatus: 'needs-human',
    effectiveStatus: 'needs-human',
    importance: 'urgent' as const,
  };

  it('maps a needs-human item with the full Answer/Resolve/Drop/Chat toolkit', () => {
    const a = planItemToAttention(base);
    expect(a.kind).toBe('plan-item');
    expect(a.planSlug).toBe('p-2026-05-31');
    expect(a.itemRef).toBe('P-007');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('urgent');
    // P-009: actions[] is the single source of truth for the card mapper, so
    // Answer + Drop must be present (they used to be hard-coded in the UI).
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat']);
    expect(a.actions.find((x) => x.id === 'mark-done')?.primary).toBe(true);
    expect(a.ref).toEqual({ kind: 'plan-item', slug: 'p-2026-05-31', itemId: 'P-007' });
  });

  it('a non-needs-human todo only gets Chat', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' });
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat']);
  });
});

describe('coordEscalationToAttention', () => {
  it('is unattached, needs-human, resolvable, importance from severity', () => {
    const a = coordEscalationToAttention({
      msgId: 'm-1',
      severity: 'blocker',
      summary: 'Which auth lib?',
      body: 'Need a decision before wiring login.',
      harnessSlug: 'papercup',
      options: [{ id: 'authjs', label: 'Auth.js' }, { id: 'lucia', label: 'Lucia' }],
    });
    expect(a.kind).toBe('coord-escalation');
    expect(a.planSlug).toBeNull();
    expect(a.itemRef).toBeNull();
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('urgent');
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'chat']);
    expect(a.ref).toMatchObject({ kind: 'coord-escalation', msgId: 'm-1' });
    if (a.ref.kind === 'coord-escalation') expect(a.ref.options).toHaveLength(2);
  });
});

describe('coordMessageToAttention', () => {
  it('is a normal, ack-able, unattached human message', () => {
    const a = coordMessageToAttention({ msgId: 'm-2', summary: 'FYI: deploy at 5pm', harnessSlug: 'papercup' });
    expect(a.kind).toBe('coord-message');
    expect(a.importance).toBe('normal');
    expect(a.needsHuman).toBe(true);
    expect(a.actions.map((x) => x.id)).toEqual(['ack', 'chat']);
  });
});

describe('smokeFailToAttention', () => {
  it('is a high, unattached harness alert with View-log', () => {
    const a = smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' });
    expect(a.kind).toBe('smoke-fail');
    expect(a.planSlug).toBeNull();
    expect(a.importance).toBe('high');
    expect(a.body).toContain('boot crashed');
    expect(a.actions.map((x) => x.id)).toEqual(['view-log', 'chat']);
  });

  it('falls back to a default body when no failure content', () => {
    expect(smokeFailToAttention({ harnessSlug: 'x' }).body).toMatch(/failing/i);
  });
});

describe('planReviewToAttention', () => {
  it('is a high, unattached review gate with Review', () => {
    const a = planReviewToAttention({ harnessSlug: 'papercup', content: '# Plan\n...' });
    expect(a.kind).toBe('plan-review');
    expect(a.importance).toBe('high');
    expect(a.needsHuman).toBe(true);
    expect(a.actions.map((x) => x.id)).toEqual(['open', 'chat']);
  });
});

describe('unified shape invariants', () => {
  it('every adapter produces a unique-prefixed id and a ref whose kind matches', () => {
    const items: AttentionItem[] = [
      planItemToAttention({ slug: 's', harnessSlug: null, id: 'P-001', text: 't', storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' }),
      coordEscalationToAttention({ msgId: 'm', severity: 'question', summary: 's' }),
      coordMessageToAttention({ msgId: 'm', summary: 's' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
      planReviewToAttention({ harnessSlug: 'h' }),
    ];
    for (const it of items) {
      expect(it.id.startsWith(`${it.kind}:`)).toBe(true);
      expect(it.ref.kind).toBe(it.kind);
      expect(it.actions.length).toBeGreaterThan(0);
    }
  });
});
