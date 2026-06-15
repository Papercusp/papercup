// PlanItemPreview — the cross-plan item detail pane. The render is a heavy
// composite (Vditor editor + chat cards + a 5-effect scroll loop → an e2e
// surface), but the genuine logic is the AttentionItem-shaped view it builds
// for the shared card mapper: buildPlanItemAttention, extracted + exported and
// tested here (field mapping + the needs-human vs default action set). The
// component's heavy child modules are stubbed so importing the helper stays
// hermetic.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./PlanEditor', () => ({ default: () => null }));
vi.mock('./PlanChat', () => ({ default: () => null }));
vi.mock('@/app/_components/chat/AskChoiceCard', () => ({ AskChoiceCard: () => null }));
vi.mock('@/app/_components/chat/InputCard', () => ({ InputCard: () => null }));
vi.mock('./QueueCardActions', () => ({ QueueCardActions: () => null }));
vi.mock('./attention-card', () => ({
  attentionItemToCardSpec: vi.fn(),
  resolveAttentionAction: vi.fn(),
  answerAttentionItem: vi.fn(),
}));
vi.mock('./plan-renderers', () => ({ scrollPlanTarget: vi.fn(), stripFrontmatter: (s: string) => s }));
vi.mock('./plans-api', () => ({ usePlan: () => ({ data: null, loading: false, error: null }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { buildPlanItemAttention } from './PlanItemPreview';
import type { PlanItem } from './plans-api';

function item(over: Partial<PlanItem> & { id: string }): PlanItem {
  return { text: '', storedStatus: 'todo', effectiveStatus: 'todo', ...over } as PlanItem;
}

describe('buildPlanItemAttention', () => {
  it('maps the core fields with a composed id and ref', () => {
    const a = buildPlanItemAttention({
      planSlug: 'my-plan',
      itemId: 'P-007',
      harnessSlug: 'orch',
      selected: item({ id: 'P-007', text: 'do the thing', storedStatus: 'todo' }),
    });
    expect(a.id).toBe('plan-item:my-plan:P-007');
    expect(a.planSlug).toBe('my-plan');
    expect(a.itemRef).toBe('P-007');
    expect(a.harnessSlug).toBe('orch');
    expect(a.title).toBe('do the thing');
    expect(a.body).toBe('do the thing');
    expect(a.status).toBe('todo');
    expect(a.ref).toEqual({ kind: 'plan-item', slug: 'my-plan', itemId: 'P-007' });
  });

  it('gives a non-needs-human item only the Chat action', () => {
    const a = buildPlanItemAttention({
      planSlug: 'p', itemId: 'P-001', selected: item({ id: 'P-001', storedStatus: 'todo' }),
    });
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat']);
  });

  it('gives a needs-human item the full Answer/Resolve/Drop/Chat toolkit', () => {
    const a = buildPlanItemAttention({
      planSlug: 'p', itemId: 'P-002', selected: item({ id: 'P-002', storedStatus: 'needs-human' }),
    });
    expect(a.needsHuman).toBe(true);
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat']);
    // Resolve is the primary action.
    expect(a.actions.find((x) => x.id === 'mark-done')?.primary).toBe(true);
  });

  it('falls back to the itemId for title and empty body when no item is selected', () => {
    const a = buildPlanItemAttention({ planSlug: 'p', itemId: 'P-009', selected: undefined });
    expect(a.title).toBe('P-009');
    expect(a.body).toBe('');
    expect(a.status).toBe('');
    expect(a.needsHuman).toBe(false);
  });

  it('normalizes a missing harnessSlug to null', () => {
    const a = buildPlanItemAttention({ planSlug: 'p', itemId: 'P-001', selected: undefined });
    expect(a.harnessSlug).toBeNull();
  });
});
