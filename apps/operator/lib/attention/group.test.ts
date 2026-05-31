import { describe, it, expect } from 'vitest';
import { buildAttentionGroups } from './group';
import {
  planItemToAttention,
  coordEscalationToAttention,
  smokeFailToAttention,
} from './adapters';

function planItem(slug: string, id: string, importance: 'urgent' | 'high' | 'normal' | 'low', harness = 'papercup') {
  return planItemToAttention({
    slug,
    harnessSlug: harness,
    id,
    text: `${id} text`,
    storedStatus: 'todo',
    effectiveStatus: 'todo',
    importance,
  });
}

describe('buildAttentionGroups', () => {
  it('groups plan items by plan slug, sorted by importance within a group', () => {
    const groups = buildAttentionGroups([
      planItem('plan-a', 'P-001', 'normal'),
      planItem('plan-a', 'P-002', 'urgent'),
      planItem('plan-b', 'P-003', 'high'),
    ]);
    const a = groups.find((g) => g.key === 'plan-a')!;
    expect(a.kind).toBe('plan');
    expect(a.items.map((i) => i.itemRef)).toEqual(['P-002', 'P-001']); // urgent first
    expect(a.maxImportance).toBe('urgent');
    expect(groups.map((g) => g.key)).toContain('plan-b');
  });

  it('routes unattached items into a per-harness Alerts bucket', () => {
    const groups = buildAttentionGroups([
      smokeFailToAttention({ harnessSlug: 'papercup', failureContent: 'boom' }),
      coordEscalationToAttention({ msgId: 'm1', severity: 'advisory', summary: 'fyi' }), // harnessSlug null → workspace
    ]);
    const alertsHarness = groups.find((g) => g.key === 'alerts:papercup')!;
    expect(alertsHarness.kind).toBe('alerts');
    expect(alertsHarness.title).toBe('Alerts — papercup');
    expect(alertsHarness.items[0].kind).toBe('smoke-fail');

    const alertsWorkspace = groups.find((g) => g.key === 'alerts:workspace')!;
    expect(alertsWorkspace.kind).toBe('alerts');
    expect(alertsWorkspace.title).toBe('Alerts');
  });

  it('orders groups by their most-important item (urgent group floats up)', () => {
    const groups = buildAttentionGroups([
      planItem('plan-low', 'P-001', 'low'),
      planItem('plan-urgent', 'P-002', 'urgent'),
      planItem('plan-normal', 'P-003', 'normal'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['plan-urgent', 'plan-normal', 'plan-low']);
  });

  it('is deterministic for equal-importance groups (key tiebreak)', () => {
    const groups = buildAttentionGroups([
      planItem('zeta', 'P-002', 'high'),
      planItem('alpha', 'P-001', 'high'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['alpha', 'zeta']);
  });

  it('returns [] for no items', () => {
    expect(buildAttentionGroups([])).toEqual([]);
  });
});
