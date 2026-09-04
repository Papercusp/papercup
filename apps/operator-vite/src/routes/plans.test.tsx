// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// See inbox.test.tsx — the component moved to components/route-content/
// behind `lazyRouteComponent` (WI-5502); mock both router entry points.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  lazyRouteComponent: (loader: unknown) => loader,
}));

vi.mock('@/app/_components/plans/PlansPane', () => ({
  default: (props: { layout?: string }) => (
    <section
      data-testid="canonical-plans-pane"
      data-layout={props.layout ?? 'stack'}
    >
      <button data-testid="plans-cleanup-start" type="button">Clean up shown plans</button>
    </section>
  ),
}));

import { PlansEmbedRoute } from '../components/route-content/PlansEmbedRoute';

afterEach(cleanup);

describe('/plans portal embed route', () => {
  it('mounts the canonical PlansPane and leaves its cleanup control intact', () => {
    render(<PlansEmbedRoute />);
    expect(screen.getByTestId('plans-portal-embed').getAttribute('data-portal-surface')).toBe('plans');
    expect(screen.getByTestId('canonical-plans-pane')).toBeTruthy();
    expect(screen.getByTestId('plans-cleanup-start')).toBeTruthy();
  });

  it('asks PlansPane for the split (list + dashboard) layout — Direction B (portal-work-two-pane-2026-09-01 P-003)', () => {
    render(<PlansEmbedRoute />);
    expect(
      screen.getByTestId('canonical-plans-pane').getAttribute('data-layout'),
    ).toBe('split');
  });
});
