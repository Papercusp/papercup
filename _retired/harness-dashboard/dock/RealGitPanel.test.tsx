// @vitest-environment jsdom
//
// RealGitPanel — dock wrapper around @papercusp/git-graph's GitGraphPanel. Thin,
// but it carries a real slug-resolution branch (harnessSlug → slug fallback →
// no-slug guard). The render-smoke confirms the no-slug guard and that a valid
// slug mounts the (mocked) library panel with the harness-scoped URL builders.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// The git-graph lib is dynamically imported; mock it to a marker that echoes the
// scope so we can assert the wrapper wired the slug through.
vi.mock('@papercusp/git-graph', () => ({
  GitGraphPanel: ({ scope }: { scope: string }) => <div data-testid="git-graph">{scope}</div>,
}));

import { RealGitPanel } from './RealGitPanel';

afterEach(cleanup);

const api = { setParams: () => {}, setTitle: () => {}, close: () => {} };

describe('<RealGitPanel />', () => {
  it('renders a guard message when no slug is present in params', () => {
    render(<RealGitPanel panelId="p" panelType="data:git" params={{}} api={api} />);
    expect(screen.getByText(/no harness slug in params/i)).toBeTruthy();
  });

  it('mounts the git graph scoped to harnessSlug', async () => {
    render(<RealGitPanel panelId="p" panelType="data:git" params={{ harnessSlug: 'my-harness' }} api={api} />);
    await waitFor(() => expect(screen.getByTestId('git-graph').textContent).toBe('harness:my-harness'));
  });

  it('falls back to the `slug` param when harnessSlug is absent', async () => {
    render(<RealGitPanel panelId="p" panelType="data:git" params={{ slug: 'fallback-h' }} api={api} />);
    await waitFor(() => expect(screen.getByTestId('git-graph').textContent).toBe('harness:fallback-h'));
  });
});
