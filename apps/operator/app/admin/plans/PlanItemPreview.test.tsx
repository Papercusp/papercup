// @vitest-environment jsdom
/**
 * PlanItemPreview.test.tsx — the cross-plan item detail pane. Covers the pure
 * buildPlanItemAttention mapper (needs-human vs plain action sets, the id/title/
 * harness/status shape, undefined-selected fallback) and the component branches:
 * the no-selection empty state, loading, error, no-content, the rendered plan
 * editor, and the toolbar's "View full plan" handoff.
 *
 * Seams: usePlan controllable; PlanEditor / PlanChat / the chat cards /
 * QueueCardActions / attention-card / plan-renderers / Tooltip / toast all
 * stubbed so only this component's own logic runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

let planState: { data: unknown; loading: boolean; error: string | null };
vi.mock('./plans-api', () => ({ usePlan: () => planState }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./PlanEditor', () => ({ default: ({ value }: { value: string }) => <div data-testid="plan-editor">{value}</div> }));
vi.mock('./PlanChat', () => ({ default: () => <div data-testid="plan-chat" /> }));
vi.mock('@/app/_components/chat/AskChoiceCard', () => ({ AskChoiceCard: () => <div data-testid="ask-card" /> }));
vi.mock('@/app/_components/chat/InputCard', () => ({ InputCard: () => <div data-testid="input-card" /> }));
vi.mock('./QueueCardActions', () => ({ QueueCardActions: () => <div data-testid="queue-actions" /> }));
vi.mock('./attention-card', () => ({
  attentionItemToCardSpec: () => ({ options: [] }),
  resolveAttentionAction: vi.fn(),
  answerAttentionItem: vi.fn(),
}));
vi.mock('./plan-renderers', () => ({ scrollPlanTarget: () => false, stripFrontmatter: (s: string) => s }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));

import PlanItemPreview, { buildPlanItemAttention } from './PlanItemPreview';

describe('buildPlanItemAttention', () => {
  it('gives a needs-human item the full Answer/Resolve/Drop/Chat action set', () => {
    const a = buildPlanItemAttention({ planSlug: 'p1', itemId: 'P-1', harnessSlug: 'h', selected: { id: 'P-1', text: 'Do thing', storedStatus: 'needs-human' } as never });
    expect(a.id).toBe('plan-item:p1:P-1');
    expect(a.needsHuman).toBe(true);
    expect(a.actions.map((x) => x.id)).toEqual(['answer', 'mark-done', 'drop', 'chat']);
    expect(a.title).toBe('Do thing');
    expect(a.harnessSlug).toBe('h');
  });
  it('gives a plain item just the Chat action', () => {
    const a = buildPlanItemAttention({ planSlug: 'p1', itemId: 'P-2', selected: { id: 'P-2', text: 'X', storedStatus: 'todo' } as never });
    expect(a.needsHuman).toBe(false);
    expect(a.actions.map((x) => x.id)).toEqual(['chat']);
    expect(a.harnessSlug).toBeNull();
  });
  it('falls back to the itemId title + empty body when nothing is selected', () => {
    const a = buildPlanItemAttention({ planSlug: 'p1', itemId: 'P-3', selected: undefined });
    expect(a.title).toBe('P-3');
    expect(a.body).toBe('');
    expect(a.status).toBe('');
    expect(a.actions.map((x) => x.id)).toEqual(['chat']);
  });
});

describe('PlanItemPreview component', () => {
  const onViewFullPlan = vi.fn();
  function renderPreview(over: { planSlug?: string | null; itemId?: string | null } = {}) {
    return render(
      <PlanItemPreview
        planSlug={over.planSlug === undefined ? 'p1' : over.planSlug}
        itemId={over.itemId === undefined ? 'P-001' : over.itemId}
        onViewFullPlan={onViewFullPlan}
      />,
    );
  }
  beforeEach(() => { onViewFullPlan.mockReset(); planState = { data: { raw: '# Body', items: [], legacy: false }, loading: false, error: null }; });
  afterEach(cleanup);

  it('shows the empty state when nothing is selected', () => {
    renderPreview({ planSlug: null });
    expect(screen.getByText(/Select an item to preview its plan here/i)).toBeTruthy();
  });

  it('shows the loading placeholder', () => {
    planState = { data: undefined, loading: true, error: null };
    renderPreview();
    expect(screen.getByText(/Loading plan…/i)).toBeTruthy();
  });

  it('shows the error placeholder', () => {
    planState = { data: undefined, loading: false, error: 'boom' };
    renderPreview();
    expect(screen.getByText(/Failed to load plan: boom/i)).toBeTruthy();
  });

  it('renders the read-only plan editor when there is content', () => {
    renderPreview();
    expect(screen.getByTestId('plan-editor').textContent).toBe('# Body');
  });

  it('shows the no-content message when the plan body is empty', () => {
    planState = { data: { raw: '', items: [], legacy: false }, loading: false, error: null };
    renderPreview();
    expect(screen.getByText(/This plan has no content/i)).toBeTruthy();
  });

  it('renders the toolbar item id and hands off to the full plan view', () => {
    renderPreview();
    expect(screen.getByText('P-001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /View full plan/i }));
    expect(onViewFullPlan).toHaveBeenCalledWith('p1', 'P-001');
  });
});
