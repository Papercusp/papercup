// @vitest-environment jsdom
/**
 * AdvPrsPanel.test.tsx — the dock-panel wrapper's own logic: pull the harness
 * slug out of the panel params and render the self-contained <PrsTab/>, or show
 * the no-slug guard. PrsTab is stubbed (it has its own test).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/app/harness/PrsTab', () => ({
  default: ({ harnessSlug }: { harnessSlug: string }) => <div data-testid="prs-tab">{harnessSlug}</div>,
}));

import AdvPrsPanel from './AdvPrsPanel';

// The component only reads `params`; cast a minimal props object.
function renderPanel(params: Record<string, unknown>) {
  return render(<AdvPrsPanel {...({ params } as never)} />);
}

afterEach(cleanup);

describe('AdvPrsPanel', () => {
  it('shows the no-slug guard when params carry no harness slug', () => {
    renderPanel({});
    expect(screen.getByText(/No harness slug in params/i)).toBeTruthy();
    expect(screen.queryByTestId('prs-tab')).toBeNull();
  });

  it('renders PrsTab with the harnessSlug param', () => {
    renderPanel({ harnessSlug: 'my-harness' });
    const tab = screen.getByTestId('prs-tab');
    expect(tab).toBeTruthy();
    expect(tab.textContent).toBe('my-harness');
  });

  it('falls back to the `slug` param when harnessSlug is absent', () => {
    renderPanel({ slug: 'fallback-slug' });
    expect(screen.getByTestId('prs-tab').textContent).toBe('fallback-slug');
  });
});
