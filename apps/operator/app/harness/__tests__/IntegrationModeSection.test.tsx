/**
 * @vitest-environment jsdom
 *
 * IntegrationModeSection — P-017 (pot-review-integration-mode-2026-10-05, D-007):
 * the pot-settings form of "Where should the agents' work go?" with guided
 * switching. Same conventions as EntryGithubUrlForm.test.tsx (no jest-dom matchers).
 *
 * The read is the LIVE `potIntegration.settings` sync query (EI-25188362216785598);
 * only the PUT goes through fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { integrationModeQuestion } from '@papercusp/operator-core/lib/harness/git-sync/integration-mode-question';
import IntegrationModeSection, { switchExplanation } from '../IntegrationModeSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

type Row = Record<string, unknown>;
const sync = vi.hoisted(() => ({
  rows: [] as Row[],
  loading: false,
  error: null as Error | null,
  invalidate: (() => {}) as () => void,
  calls: [] as Array<{ queryName: string; args: unknown }>,
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args: unknown }) => {
    sync.calls.push({ queryName: opts.queryName, args: opts.args });
    return { data: sync.rows, loading: sync.loading, fetching: false, error: sync.error, invalidate: sync.invalidate };
  },
}));

const mockFetch = vi.fn<typeof fetch>();
const invalidate = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function settingsRow(opts: { current?: 'direct' | 'review' | null; hasTestSuite?: boolean; workingCopyUrl?: string | null } = {}): Row {
  return {
    slug: 'widgets',
    isPot: true,
    question: integrationModeQuestion({ repoLabel: 'acme/widgets', hasTestSuite: opts.hasTestSuite }),
    current: opts.current ?? null,
    workingCopyUrl: opts.workingCopyUrl ?? null,
  };
}

function putCalls() {
  return mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

beforeEach(() => {
  mockFetch.mockReset();
  invalidate.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  sync.rows = [];
  sync.loading = false;
  sync.error = null;
  sync.invalidate = invalidate;
  sync.calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('IntegrationModeSection', () => {
  it('asks the owner-approved question with the repo name and marks the current answer', async () => {
    sync.rows = [settingsRow({ current: null })];
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    expect(sync.calls[0]).toEqual({ queryName: 'potIntegration.settings', args: { slug: 'widgets' } });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('heading').textContent).toBe("Where should the agents' work go?");
    const direct = screen.getByTestId('integration-mode-option-direct');
    const review = screen.getByTestId('integration-mode-option-review');
    expect(direct.textContent).toContain('Straight into acme/widgets');
    expect(direct.textContent).toContain('(current)');
    expect(review.textContent).toContain('Into a working copy of acme/widgets');
    expect((direct.querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  it('a switch saved elsewhere shows up live, with no reload (EI-25188362216785598)', async () => {
    sync.rows = [settingsRow({ current: 'direct' })];
    const { rerender } = render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    expect(screen.getByTestId('integration-mode-option-direct').textContent).toContain('(current)');

    // The pushed row after a peer (or another window) switched the pot to the working copy.
    sync.rows = [settingsRow({ current: 'review', workingCopyUrl: 'https://github.com/bot/widgets' })];
    rerender(<IntegrationModeSection slug="widgets" />);
    expect(screen.getByTestId('integration-mode-option-review').textContent).toContain('(current)');
    expect(screen.getByTestId('integration-mode-working-copy').textContent).toContain('https://github.com/bot/widgets');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('choosing the other answer shows a confirm step and sends nothing until Switch', async () => {
    sync.rows = [settingsRow({ current: 'direct' })];
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    const panel = screen.getByTestId('integration-mode-confirm-panel');
    expect(panel.textContent).toContain('acme/widgets receives their combined work only through a PR');
    expect(putCalls()).toHaveLength(0);

    await userEvent.click(screen.getByTestId('integration-mode-cancel'));
    expect(screen.queryByTestId('integration-mode-confirm-panel')).toBeNull();
    expect((screen.getByTestId('integration-mode-option-direct').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(putCalls()).toHaveLength(0);
  });

  it('Switch PUTs the new answer, shows the working copy it created, and re-reads the setting', async () => {
    sync.rows = [settingsRow({ current: 'direct' })];
    mockFetch.mockResolvedValueOnce(json({ ok: true, mode: 'review', fork: { url: 'https://github.com/bot/widgets', created: true } }));
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    await userEvent.click(screen.getByTestId('integration-mode-confirm'));

    await waitFor(() => expect(screen.queryByTestId('integration-mode-confirm-panel')).toBeNull());
    const puts = putCalls();
    expect(puts).toHaveLength(1);
    expect(puts[0]![0]).toBe('/api/harness/widgets/integration-mode');
    expect(JSON.parse((puts[0]![1] as RequestInit).body as string)).toEqual({ mode: 'review' });
    expect(screen.getByTestId('integration-mode-option-review').textContent).toContain('(current)');
    expect(screen.getByTestId('integration-mode-working-copy').textContent).toContain('https://github.com/bot/widgets');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('a refused switch shows the server message and keeps the current answer', async () => {
    sync.rows = [settingsRow({ current: 'direct' })];
    mockFetch.mockResolvedValueOnce(
      json({ ok: false, error: 'upstream_remote_required', message: 'This pot has no GitHub repository to copy.' }, 409),
    );
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    await userEvent.click(screen.getByTestId('integration-mode-option-review').querySelector('input')!);
    await userEvent.click(screen.getByTestId('integration-mode-confirm'));

    const err = await screen.findByTestId('integration-mode-error');
    expect(err.textContent).toBe('This pot has no GitHub repository to copy.');
    expect(screen.getByTestId('integration-mode-option-direct').textContent).toContain('(current)');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('without a test suite the working copy is disabled and says why', async () => {
    sync.rows = [settingsRow({ current: 'direct', hasTestSuite: false })];
    render(<IntegrationModeSection slug="widgets" />);
    await screen.findByTestId('integration-mode-settings');
    const review = screen.getByTestId('integration-mode-option-review');
    expect((review.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(review.textContent).toContain('This repository has no test suite');
  });

  it('renders nothing for a project that is not a pot', async () => {
    sync.rows = [{ slug: 'plain', isPot: false }];
    const { container } = render(<IntegrationModeSection slug="plain" />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('a failed read (no row once loaded) is shown, not silently blank', async () => {
    sync.rows = [];
    sync.error = new Error('read failed');
    render(<IntegrationModeSection slug="widgets" />);
    expect((await screen.findByTestId('integration-mode-section')).textContent).toContain('read failed');
  });
});

describe('switchExplanation', () => {
  it('explains the working copy, naming it when it exists', () => {
    expect(switchExplanation('review', 'acme/widgets', 'https://github.com/bot/widgets')).toContain(
      'the working copy (https://github.com/bot/widgets)',
    );
    expect(switchExplanation('review', 'acme/widgets', null)).toContain('created for this pot');
  });

  it('switching back says the working copy is kept', () => {
    const text = switchExplanation('direct', 'acme/widgets', 'https://github.com/bot/widgets');
    expect(text).toContain('straight into acme/widgets');
    expect(text).toContain('nothing is deleted');
  });
});
