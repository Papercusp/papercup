// @vitest-environment jsdom
//
// AdvGitPanel — the two-pane Git panel (graph list | commit detail). Real
// branches: the no-slug guard, the empty placeholder when ?gitSha is unset, and
// the CommitDetail pane once a commit is selected (deep-linked via ?gitSha, or
// chosen through the graph's onCommitSelect → ?gitSha write). The heavy
// @papercusp/git-graph module (GitGraphPanel + CommitDetail) is stubbed so we
// assert AdvGitPanel's own slug/sha wiring.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
// Stub the whole git-graph module: GitGraphPanel exposes its props (so we can
// drive onCommitSelect) and CommitDetail echoes the selected sha + a close.
vi.mock('@papercusp/git-graph', () => ({
  GitGraphPanel: ({
    scope,
    selectedSha,
    onCommitSelect,
  }: {
    scope: string;
    selectedSha: string | null;
    onCommitSelect: (sha: string | null) => void;
  }) => (
    <div data-testid="git-graph">
      <span data-testid="scope">{scope}</span>
      <span data-testid="selected">{selectedSha ?? ''}</span>
      <button data-testid="pick" onClick={() => onCommitSelect('deadbeef')}>
        pick
      </button>
    </div>
  ),
  CommitDetail: ({ sha, onClose }: { sha: string; onClose: () => void }) => (
    <div data-testid="commit-detail">
      <span data-testid="detail-sha">{sha}</span>
      <button data-testid="detail-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
// crossOriginUrl is a pure path helper — passthrough is enough.
vi.mock('@papercusp/operator-core/lib/cross-origin-url', () => ({
  crossOriginUrl: (p: string) => p,
}));

import { AdvGitPanel } from './AdvGitPanel';

function panelProps(params: Record<string, unknown> = {}) {
  return { panelId: 'p', panelType: 'adv:git', params, api: {} } as never;
}

function renderPanel(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

afterEach(cleanup);

describe('AdvGitPanel', () => {
  it('renders the no-slug guard when neither harnessSlug nor slug is in params', () => {
    renderPanel(<AdvGitPanel {...panelProps({})} />);
    expect(screen.getByText(/No harness slug in params/i)).toBeTruthy();
    expect(screen.queryByTestId('git-graph')).toBeNull();
  });

  it('renders the graph and the empty detail placeholder when no commit is selected', async () => {
    renderPanel(<AdvGitPanel {...panelProps({ harnessSlug: 'my-harness' })} />);
    // GitGraphPanel is lazy-loaded → wait for the stub to resolve.
    await waitFor(() => expect(screen.getByTestId('git-graph')).toBeTruthy());
    expect(screen.getByTestId('scope').textContent).toBe('harness:my-harness');
    expect(screen.getByText(/Select a commit to view its diff/i)).toBeTruthy();
    expect(screen.queryByTestId('commit-detail')).toBeNull();
  });

  it('falls back to params.slug when harnessSlug is absent', async () => {
    renderPanel(<AdvGitPanel {...panelProps({ slug: 'fallback-h' })} />);
    await waitFor(() => expect(screen.getByTestId('scope').textContent).toBe('harness:fallback-h'));
  });

  it('renders the CommitDetail pane when ?gitSha is deep-linked', async () => {
    renderPanel(<AdvGitPanel {...panelProps({ harnessSlug: 'h' })} />, '?gitSha=cafef00d');
    await waitFor(() => expect(screen.getByTestId('commit-detail')).toBeTruthy());
    expect(screen.getByTestId('detail-sha').textContent).toBe('cafef00d');
    expect(screen.queryByText(/Select a commit/i)).toBeNull();
  });

  it('selecting a commit in the graph writes ?gitSha and opens the detail', async () => {
    renderPanel(<AdvGitPanel {...panelProps({ harnessSlug: 'h' })} />);
    await waitFor(() => expect(screen.getByTestId('pick')).toBeTruthy());
    fireEvent.click(screen.getByTestId('pick'));
    await waitFor(() => expect(screen.getByTestId('detail-sha').textContent).toBe('deadbeef'));
  });

  it('closing the CommitDetail clears ?gitSha back to the placeholder', async () => {
    renderPanel(<AdvGitPanel {...panelProps({ harnessSlug: 'h' })} />, '?gitSha=abc123');
    await waitFor(() => expect(screen.getByTestId('commit-detail')).toBeTruthy());
    fireEvent.click(screen.getByTestId('detail-close'));
    await waitFor(() => expect(screen.getByText(/Select a commit to view its diff/i)).toBeTruthy());
    expect(screen.queryByTestId('commit-detail')).toBeNull();
  });
});
