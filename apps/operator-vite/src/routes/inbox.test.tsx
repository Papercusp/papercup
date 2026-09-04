// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// `routes/inbox.tsx` now only registers the route and points at
// `components/route-content/InboxEmbedRoute` through `lazyRouteComponent`
// (WI-5502 — a route module that also exports its component defeats
// autoCodeSplitting). Mock both router entry points so importing the route
// module stays safe, and assert against the component where it now lives.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  lazyRouteComponent: (loader: unknown) => loader,
}));

vi.mock('@/app/_components/inbox/InboxPane', () => ({
  default: (props: { layout?: string }) => (
    <section
      data-testid="canonical-inbox-pane"
      data-layout={props.layout ?? 'stack'}
    >
      <button data-testid="inbox-bulk-start" type="button">Bulk resolve shown items</button>
    </section>
  ),
}));

import { InboxEmbedRoute } from '../components/route-content/InboxEmbedRoute';

afterEach(cleanup);

describe('/inbox portal embed route', () => {
  it('mounts the canonical InboxPane and leaves its bulk resolve control intact', () => {
    render(<InboxEmbedRoute />);
    expect(screen.getByTestId('inbox-portal-embed').getAttribute('data-portal-surface')).toBe('inbox');
    expect(screen.getByTestId('canonical-inbox-pane')).toBeTruthy();
    expect(screen.getByTestId('inbox-bulk-start')).toBeTruthy();
  });

  it('asks InboxPane for the split (list + detail) layout — Direction B (portal-work-two-pane-2026-09-01 P-003)', () => {
    render(<InboxEmbedRoute />);
    expect(
      screen.getByTestId('canonical-inbox-pane').getAttribute('data-layout'),
    ).toBe('split');
  });
});
