// @vitest-environment jsdom
/**
 * PlanItemPreview.test.tsx — the cross-plan item detail pane's component branches:
 * the no-selection empty state, loading, error, no-content, the rendered plan
 * editor, and the toolbar's "View full plan" handoff. The pure
 * buildPlanItemAttention mapper is covered once in PlanItemPreview.test.ts.
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

import PlanItemPreview from './PlanItemPreview';

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
