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

describe('planItemToAttention — tier + needsHuman (D-001/D-002/D-006)', () => {
  const base = {
    slug: 'p-2026-05-31',
    harnessSlug: 'papercup',
    id: 'P-007',
    text: 'Sign off before ship',
    storedStatus: 'needs-human',
    effectiveStatus: 'needs-human',
    importance: 'urgent' as const,
  };

  it('needs-human → decision tier + the full Answer/Resolve/Drop/Chat/Message-owner toolkit', () => {
    const a = planItemToAttention(base);
    expect(a.kind).toBe('plan-item');
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.triageState).toBe('untriaged');
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat', 'message-owner']);
    expect(a.actions.find((x) => x.id === 'mark-done')?.primary).toBe(true);
    expect(a.ref).toEqual({ kind: 'plan-item', slug: 'p-2026-05-31', itemId: 'P-007' });
  });

  it('blocked → alert tier (not a decision), Chat + Message owner only', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'blocked', effectiveStatus: 'blocked', importance: 'normal' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('todo → activity tier, not needs-human', () => {
    const a = planItemToAttention({ ...base, storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat', 'message-owner']);
  });

  it('carries an explicit owner when resolved', () => {
    const a = planItemToAttention({ ...base, ownerAgentId: 'su-worker', ownerLabel: 'worker' });
    expect(a.ownerAgentId).toBe('su-worker');
    expect(a.ownerLabel).toBe('worker');
  });
});

describe('coordEscalationToAttention — severity → tier', () => {
  it('blocker → decision (urgent), resolvable, owner from `from`', () => {
    const a = coordEscalationToAttention({
      msgId: 'm-1',
      severity: 'blocker',
      summary: 'Which auth lib?',
      harnessSlug: 'papercup',
      from: 'su-architect',
      options: [{ id: 'authjs', label: 'Auth.js' }, { id: 'lucia', label: 'Lucia' }],
    });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('urgent');
    expect(a.ownerAgentId).toBe('su-architect');
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'chat', 'message-owner']);
    if (a.ref.kind === 'coord-escalation') expect(a.ref.options).toHaveLength(2);
  });

  it('question → decision (this is where ask-owner lands)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-q', severity: 'question', summary: 'ok to proceed?' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.importance).toBe('high');
    // No harness → no Chat, but Message owner is always offered.
    expect(a.actions.map((x) => x.id)).toEqual(['resolve', 'message-owner']);
  });

  it('advisory → alert (FYI, not a decision)', () => {
    const a = coordEscalationToAttention({ msgId: 'm-a', severity: 'advisory', summary: 'heads up' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.importance).toBe('low');
  });
});

describe('coordMessageToAttention — structured classification (D-003)', () => {
  it('a plain broadcast FYI → activity, not needs-human', () => {
    const a = coordMessageToAttention({ msgId: 'm-2', summary: 'apps/tui is GREEN again', harnessSlug: 'papercup' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['ack', 'chat', 'message-owner']);
  });

  it('an auto lifecycle broadcast → activity (the over-flagging fix)', () => {
    const a = coordMessageToAttention({ msgId: 'm-3', summary: '▶ now working on X', auto: true, lifecycle: 'intent' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('lifecycle marker alone (no auto flag) still → activity', () => {
    const a = coordMessageToAttention({ msgId: 'm-3b', summary: '✅ done', lifecycle: 'completion' });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });

  it('a non-auto message addressed directly to the human → decision', () => {
    const a = coordMessageToAttention({ msgId: 'm-4', summary: 'can you confirm the rename?', directToOwner: true, from: 'su-worker' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.ownerAgentId).toBe('su-worker');
  });

  it('an auto message addressed to the human is STILL activity (lifecycle wins)', () => {
    const a = coordMessageToAttention({ msgId: 'm-5', summary: '✅ done', auto: true, lifecycle: 'completion', directToOwner: true });
    expect(a.tier).toBe('activity');
    expect(a.needsHuman).toBe(false);
  });
});

describe('smokeFailToAttention — alert tier', () => {
  it('is an alert (a problem to surface), not a decision', () => {
    const a = smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boot crashed' });
    expect(a.tier).toBe('alert');
    expect(a.needsHuman).toBe(false);
    expect(a.body).toContain('boot crashed');
    expect(a.actions.map((x) => x.id)).toEqual(['view-log', 'chat', 'message-owner']);
  });
});

describe('planReviewToAttention — decision tier (gate)', () => {
  it('is a decision (a gate awaiting approval)', () => {
    const a = planReviewToAttention({ harnessSlug: 'papercup', content: '# Plan' });
    expect(a.tier).toBe('decision');
    expect(a.needsHuman).toBe(true);
    expect(a.actions.map((x) => x.id)).toEqual(['open', 'chat', 'message-owner']);
  });
});

describe('unified shape invariants', () => {
  it('every adapter: unique-prefixed id, ref kind matches, needsHuman===decision, untriaged default, message-owner present', () => {
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
      expect(it.needsHuman).toBe(it.tier === 'decision');
      expect(it.triageState).toBe('untriaged');
      expect(it.actions.some((a) => a.id === 'message-owner')).toBe(true);
    }
  });
});

describe('needsHuman drops at the source (Brief 21 — the 62→12 intent)', () => {
  it('a representative feed leaves only genuine decisions as needs-human', () => {
    const items: AttentionItem[] = [
      // ── noise: auto lifecycle broadcasts (the bulk of the old false positives)
      ...Array.from({ length: 10 }, (_, i) =>
        coordMessageToAttention({ msgId: `auto-${i}`, summary: '▶ now working on', auto: true, lifecycle: 'intent' }),
      ),
      // ── alerts (surface, but not decisions)
      coordEscalationToAttention({ msgId: 'adv', severity: 'advisory', summary: 'fyi' }),
      smokeFailToAttention({ harnessSlug: 'h' }),
      planItemToAttention({ slug: 's', harnessSlug: 'h', id: 'P-9', text: 'stuck', storedStatus: 'blocked', effectiveStatus: 'blocked', importance: 'normal' }),
      // ── activity (normal work)
      ...Array.from({ length: 3 }, (_, i) =>
        planItemToAttention({ slug: 's', harnessSlug: 'h', id: `P-${i}`, text: 'work', storedStatus: 'todo', effectiveStatus: 'todo', importance: 'normal' }),
      ),
      // ── genuine decisions
      planItemToAttention({ slug: 's', harnessSlug: 'h', id: 'P-NH', text: 'sign off', storedStatus: 'needs-human', effectiveStatus: 'needs-human', importance: 'urgent' }),
      coordEscalationToAttention({ msgId: 'blk', severity: 'blocker', summary: 'blocked decision' }),
      coordEscalationToAttention({ msgId: 'ask', severity: 'question', summary: 'ask-owner question' }),
      planReviewToAttention({ harnessSlug: 'h' }),
    ];
    const needsHuman = items.filter((i) => i.needsHuman);
    // 20 items, only the 4 genuine decisions await the human.
    expect(items.length).toBe(20);
    expect(needsHuman.length).toBe(4);
    expect(needsHuman.every((i) => i.tier === 'decision')).toBe(true);
  });
});
